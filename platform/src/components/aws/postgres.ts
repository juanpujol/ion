import {
  ComponentResourceOptions,
  interpolate,
  jsonParse,
  output,
  Output,
} from "@pulumi/pulumi";
import { Component, Transform, transform } from "../component";
import { Link } from "../link";
import { Input } from "../input.js";
import { rds, secretsmanager } from "@pulumi/aws";
import { permission } from "./permission";
import { RandomPassword } from "@pulumi/random";
import { Vpc } from "./vpc";
import { Vpc as VpcV1 } from "./vpc-v1";
import { VisibleError } from "../error";

export interface PostgresArgs {
  /**
   * The VPC to use for the database cluster.
   *
   * Each AWS account has a default VPC. If `default` is specified, the default VPC is used.
   *
   * :::note
   * The default VPC does not have private subnets and is not recommended for production use.
   * :::
   *
   * @example
   * ```js
   * {
   *   vpc: {
   *     privateSubnets: ["subnet-0db7376a7ad4db5fd ", "subnet-06fc7ee8319b2c0ce"],
   *   }
   * }
   * ```
   *
   * Or create a `Vpc` component.
   *
   * ```js
   * const myVpc = new sst.aws.Vpc("MyVpc");
   * ```
   *
   * And pass it in.
   *
   * ```js
   * {
   *   vpc: myVpc
   * }
   * ```
   */
  vpc:
    | Vpc
    | Input<{
        /**
         * A list of private subnet IDs in the VPC. The database will be placed in the private
         * subnets.
         */
        subnets: Input<Input<string>[]>;
      }>;
  //replicas?: Input<number>;
  /**
   * The type of instance to use for the database. Check out the [supported instance types](https://docs.aws.amazon.com/AmazonElastiCache/latest/red-ug/CacheNodes.SupportedTypes.html).
   *
   * @default `"t4g.micro"`
   * @example
   * ```js
   * {
   *   instance: "m7g.xlarge"
   * }
   * ```
   */
  instance?: Input<string>;
  /**
   * [Transform](/docs/components#transform) how this component creates its underlying
   * resources.
   */
  transform?: {
    /**
     * Transform the RDS subnet group.
     */
    subnetGroup?: Transform<rds.SubnetGroupArgs>;
    /**
     * Transform the RDS parameter group.
     */
    parameterGroup?: Transform<rds.ParameterGroupArgs>;
    /**
     * Transform the database instance in the RDS Cluster.
     */
    instance?: Transform<rds.InstanceArgs>;
  };
}

/**
 * The `Postgres` component lets you add a Postgres database to your app using
 * [Amazon Aurora Serverless v2](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2.html).
 *
 * :::note
 * Data API for Aurora Postgres Serverless v2 is still being [rolled out in all regions](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Concepts.Aurora_Fea_Regions_DB-eng.Feature.ServerlessV2.html#Concepts.Aurora_Fea_Regions_DB-eng.Feature.ServerlessV2.apg).
 * :::
 *
 * To connect to your database from your Lambda functions, you can use the
 * [AWS Data API](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/data-api.html). It
 * does not need a persistent connection, and works over HTTP. You also don't need a VPN to
 * connect to it locally.
 *
 * @example
 *
 * #### Create the database
 *
 * ```js title="sst.config.ts"
 * const vpc = new sst.aws.Vpc("MyVpc");
 * const database = new sst.aws.Postgres("MyDatabase", { vpc });
 * ```
 *
 * #### Change the scaling config
 *
 * ```js title="sst.config.ts"
 * new sst.aws.Postgres("MyDatabase", {
 *   scaling: {
 *     min: "2 ACU",
 *     max: "128 ACU"
 *   },
 *   vpc
 * });
 * ```
 *
 * #### Link to a resource
 *
 * You can link your database to other resources, like a function or your Next.js app.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.Nextjs("MyWeb", {
 *   link: [database],
 *   vpc
 * });
 * ```
 *
 * Once linked, you can connect to it from your function code.
 *
 * ```ts title="app/page.tsx" {1,6,7,8}
 * import { Resource } from "sst";
 * import { drizzle } from "drizzle-orm/aws-data-api/pg";
 * import { RDSDataClient } from "@aws-sdk/client-rds-data";
 *
 * drizzle(new RDSDataClient({}), {
 *   database: Resource.MyDatabase.database,
 *   secretArn: Resource.MyDatabase.secretArn,
 *   resourceArn: Resource.MyDatabase.clusterArn
 * });
 * ```
 */
export class Postgres extends Component implements Link.Linkable {
  private instance: rds.Instance;

  constructor(
    name: string,
    args: PostgresArgs,
    opts?: ComponentResourceOptions,
  ) {
    super(__pulumiType, name, args, opts);

    const parent = this;

    const instanceType = output(args.instance).apply((v) => v ?? "t4g.micro");
    const vpc = normalizeVpc();
    const subnetGroup = createSubnetGroup();
    const parameterGroup = createParameterGroup();
    const password = createPassword();
    const instance = createInstance();
    //const replicas = createReplicas();

    this.instance = instance;

    function normalizeVpc() {
      // "vpc" is a Vpc.v1 component
      if (args.vpc instanceof VpcV1) {
        throw new VisibleError(
          `You are using the "Vpc.v1" component. Please migrate to the latest "Vpc" component.`,
        );
      }

      // "vpc" is a Vpc component
      if (args.vpc instanceof Vpc) {
        return {
          subnets: args.vpc.privateSubnets,
        };
      }

      // "vpc" is object
      return output(args.vpc);
    }

    function createSubnetGroup() {
      return new rds.SubnetGroup(
        ...transform(
          args.transform?.subnetGroup,
          `${name}SubnetGroup`,
          {
            subnetIds: vpc.subnets,
          },
          { parent },
        ),
      );
    }

    function createParameterGroup() {
      return new rds.ParameterGroup(
        ...transform(
          args.transform?.parameterGroup,
          `${name}ParameterGroup`,
          {
            family: "postgres16",
            parameters: [
              {
                name: "rds.force_ssl",
                value: "0",
              },
            ],
          },
          { parent },
        ),
      );
    }

    function createPassword() {
      return new RandomPassword(`${name}Password`, {
        length: 32,
        special: false,
      });
    }

    function createInstance() {
      return new rds.Instance(
        ...transform(
          args.transform?.instance,
          `${name}Instance`,
          {
            dbName: $app.name.replaceAll("-", "_"),
            dbSubnetGroupName: subnetGroup.name,
            engine: "postgres",
            engineVersion: "16.3",
            instanceClass: interpolate`db.${instanceType}`,
            username: "postgres",
            password: password.result,
            parameterGroupName: parameterGroup.name,
            skipFinalSnapshot: true,
            storageEncrypted: true,
            storageType: "gp3",
            allocatedStorage: 20,
            maxAllocatedStorage: 100,
            backupRetentionPeriod: 7,
          },
          { parent, deleteBeforeReplace: true },
        ),
      );
    }

    //    function createReplicas() {
    //      return output(args.replicas).apply((replicas) => {
    //        if (!replicas) return [];
    //
    //        for (let i = 0; i < replicas; i++) {
    //          new rds.Instance(`${name}Replica${i}`, {
    //            replicateSourceDb: instance.identifier,
    //            dbSubnetGroupName: instance.dbSubnetGroupName,
    //            engine: instance.engine,
    //            engineVersion: instance.engineVersion,
    //            instanceClass: instance.instanceClass,
    //            parameterGroupName: instance.parameterGroupName,
    //            skipFinalSnapshot: true,
    //            storageEncrypted: instance.storageEncrypted.apply((v) => v!),
    //            storageType: instance.storageType,
    //            allocatedStorage: instance.allocatedStorage,
    //            maxAllocatedStorage: instance.maxAllocatedStorage.apply((v) => v!),
    //            backupRetentionPeriod: instance.backupRetentionPeriod,
    //          });
    //        }
    //      });
    //    }
  }

  /** The username of the master user. */
  public get username() {
    return this.instance.username;
  }

  /** The password of the master user. */
  public get password() {
    return this.instance.password;
  }

  /**
   * The name of the database.
   */
  public get database() {
    return this.instance.dbName;
  }

  /**
   * The port of the database.
   */
  public get port() {
    return this.instance.port;
  }

  /**
   * The host of the database.
   */
  public get host() {
    return this.instance.endpoint.apply((endpoint) => endpoint.split(":")[0]);
  }

  public get nodes() {
    return {
      instance: this.instance,
    };
  }

  /** @internal */
  public getSSTLink() {
    //return { properties: { foo: "bar" } };
    return {
      properties: {
        database: this.database,
        username: this.username,
        password: this.password,
        port: this.port,
        host: this.host,
      },
    };
  }

  /**
   * Reference an existing Postgres cluster with the given cluster name. This is useful when you
   * create a Postgres cluster in one stage and want to share it in another. It avoids having to
   * create a new Postgres cluster in the other stage.
   *
   * :::tip
   * You can use the `static get` method to share Postgres clusters across stages.
   * :::
   *
   * @param name The name of the component.
   * @param clusterID The id of the existing Postgres cluster.
   *
   * @example
   * Imagine you create a cluster in the `dev` stage. And in your personal stage `frank`,
   * instead of creating a new cluster, you want to share the same cluster from `dev`.
   *
   * ```ts title="sst.config.ts"
   * const database = $app.stage === "frank"
   *   ? sst.aws.Postgres.get("MyDatabase", "app-dev-mydatabase")
   *   : new sst.aws.Postgres("MyDatabase");
   * ```
   *
   * Here `app-dev-mydatabase` is the ID of the cluster created in the `dev` stage.
   * You can find this by outputting the cluster ID in the `dev` stage.
   *
   * ```ts title="sst.config.ts"
   * return {
   *   cluster: database.clusterID
   * };
   * ```
   */
  public static get(name: string, clusterID: Input<string>) {
    const cluster = rds.Cluster.get(`${name}Cluster`, clusterID);
    const instances = rds.getInstancesOutput({
      filters: [{ name: "db-cluster-id", values: [clusterID] }],
    });
    const instance = rds.ClusterInstance.get(
      `${name}Instance`,
      instances.apply((instances) => {
        if (instances.instanceIdentifiers.length === 0)
          throw new Error(`No instance found for cluster ${clusterID}`);
        return instances.instanceIdentifiers[0];
      }),
    );
    return new Postgres(name, {
      ref: true,
      cluster,
      instance,
    } as unknown as PostgresArgs);
  }
}

const __pulumiType = "sst:aws:Postgres";
// @ts-expect-error
Postgres.__pulumiType = __pulumiType;

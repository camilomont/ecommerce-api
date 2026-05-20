import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';

export class EcommerceApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 1. BASES DE DATOS (DynamoDB)
    const usersTable = new dynamodb.Table(this, 'UsersTable', {
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      tableName: 'Users',
    });

    const productsTable = new dynamodb.Table(this, 'ProductsTable', {
      partitionKey: { name: 'productId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      tableName: 'Products',
    });

    const ordersTable = new dynamodb.Table(this, 'OrdersTable', { //tabla de pedidos
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'productId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      tableName: 'Orders',
    });

    const productImagesBucket = new s3.Bucket(this, 'ProductImagesBucket', {
      versioned: false,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      publicReadAccess: true,
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicAcls: false,
        blockPublicPolicy: false,
        ignorePublicAcls: false,
        restrictPublicBuckets: false,
      }),
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
        },
      ],
    });

    // 2. FUNCIONES LAMBDA
    const userLambda = new lambda.Function(this, 'UserHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'users.handler',
      code: lambda.Code.fromAsset('lambda'),
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      tracing: lambda.Tracing.ACTIVE,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        TABLE_NAME: usersTable.tableName,
        PRODUCTS_TABLE_NAME: productsTable.tableName,
        ORDERS_TABLE_NAME: ordersTable.tableName,
      },
    });

    const productLambda = new lambda.Function(this, 'ProductHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'products.handler',
      code: lambda.Code.fromAsset('lambda'),
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      tracing: lambda.Tracing.ACTIVE,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        TABLE_NAME: productsTable.tableName,
        BUCKET_NAME: productImagesBucket.bucketName,
      },
    });

    // Otorga permisos a las Lambdas para leer/escribir en sus tablas
    usersTable.grantReadWriteData(userLambda);
    productsTable.grantReadData(userLambda);
    productsTable.grantReadWriteData(productLambda);
    ordersTable.grantReadWriteData(userLambda);
    productImagesBucket.grantWrite(productLambda);

    // 3. API GATEWAY
    const apiAccessLogs = new logs.LogGroup(this, 'ApiAccessLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const api = new apigateway.RestApi(this, 'EcommerceApi', {
      restApiName: 'Ecommerce Service V2',
      description: 'API para gestionar Usuarios y Productos.',
      cloudWatchRole: true,
      binaryMediaTypes: ['multipart/form-data'],
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization'],
      },
      deployOptions: {
        stageName: 'prod',
        metricsEnabled: true,
        tracingEnabled: true,
        loggingLevel: apigateway.MethodLoggingLevel.ERROR,
        dataTraceEnabled: false,
        accessLogDestination: new apigateway.LogGroupLogDestination(apiAccessLogs),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields({
          caller: false,
          httpMethod: true,
          ip: true,
          protocol: true,
          requestTime: true,
          resourcePath: true,
          responseLength: true,
          status: true,
          user: false,
        }),
        throttlingRateLimit: 50,
        throttlingBurstLimit: 100,
      },
    });

    const userIntegration = new apigateway.LambdaIntegration(userLambda);
    const productIntegration = new apigateway.LambdaIntegration(productLambda);

    // Recurso /products
    const productsResource = api.root.addResource('products');
    productsResource.addMethod('GET', productIntegration);
    productsResource.addMethod('POST', productIntegration);
    const productsUploadUrlResource = productsResource.addResource('upload-url');
    productsUploadUrlResource.addMethod('POST', productIntegration);
    const singleProductResource = productsResource.addResource('{productId}');
    singleProductResource.addMethod('PUT', productIntegration);
    singleProductResource.addMethod('DELETE', productIntegration);

    // Recurso /users
    const usersResource = api.root.addResource('users');
    usersResource.addMethod('GET', userIntegration);
    usersResource.addMethod('POST', userIntegration);

    // Recurso /users/{userId}/products
    const singleUserResource = usersResource.addResource('{userId}');
    singleUserResource.addMethod('PUT', userIntegration);
    singleUserResource.addMethod('DELETE', userIntegration);
    const userProductsResource = singleUserResource.addResource('products');
    userProductsResource.addMethod('POST', userIntegration);
    userProductsResource.addMethod('GET', userIntegration);
  }
}
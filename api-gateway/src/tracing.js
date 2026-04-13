const { NodeSDK } = require("@opentelemetry/sdk-node");
const { Resource } = require("@opentelemetry/resources");
const { SemanticResourceAttributes } = require("@opentelemetry/semantic-conventions");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
const { getNodeAutoInstrumentations } = require("@opentelemetry/auto-instrumentations-node");

const serviceName = "api-gateway";
const otlpBaseUrl =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://otel-collector:4318";
const traceEndpoint =
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || `${otlpBaseUrl}/v1/traces`;

const sdk = new NodeSDK({
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
  }),
  traceExporter: new OTLPTraceExporter({ url: traceEndpoint }),
  instrumentations: [
    getNodeAutoInstrumentations({
      "@opentelemetry/instrumentation-http": { enabled: true },
      "@opentelemetry/instrumentation-express": { enabled: true },
      "@opentelemetry/instrumentation-pg": { enabled: false },
      "@opentelemetry/instrumentation-redis-4": { enabled: false },
      "@opentelemetry/instrumentation-ioredis": { enabled: false },
    }),
  ],
});

sdk.start();

const shutdown = () =>
  sdk.shutdown().finally(() => {
    process.exit(0);
  });

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

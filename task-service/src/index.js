require("./tracing");
const { register, httpRequestsTotal, httpRequestDurationMs } = require("./metrics");
const express = require("express");
const { context, trace } = require("@opentelemetry/api");
const pino = require("pino");
const pinoHttp = require("pino-http");
const { router: routes, refreshTasksGaugeFromDb } = require("./routes");

const ERROR_CODE = 500;

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  mixin() {
    const activeSpan = trace.getSpan(context.active());
    if (!activeSpan) return {};

    const spanContext = activeSpan.spanContext();
    return {
      trace_id: spanContext.traceId,
      span_id: spanContext.spanId,
    };
  },
});
const app = express();

function getRouteLabel(req) {
  if (req.route?.path) {
    return `${req.baseUrl || ""}${req.route.path}`;
  }
  return req.baseUrl || req.path || "unknown_route";
}

app.use((req, res, next) => {
  const start = process.hrtime.bigint();

  res.on("finish", () => {
    const route = getRouteLabel(req);
    const labels = {
      method: req.method,
      route,
      status: String(res.statusCode),
    };

    httpRequestsTotal.labels(labels.method, labels.route, labels.status).inc();

    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    httpRequestDurationMs
      .labels(labels.method, labels.route, labels.status)
      .observe(durationMs);
  });

  next();
});

app.use(express.json());
app.use(
  pinoHttp({
    logger,
    customLogLevel: (req, res) => {
      if (res.statusCode >= ERROR_CODE) return "error";
      return "info";
    },
    customSuccessMessage: (req, res) => {
      if (res.statusCode >= 400) return req.errorMessage ?? `request failed`;
      return `${req.method} completed`;
    },
    customErrorMessage: (req, res, err) => `request failed : ${err.message}`,
  }),
);

app.get("/health", (req, res) =>
  res.json({ status: "ok", service: "task-service" }),
);

app.get("/metrics", async (req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

app.use("/tasks", routes);

const PORT = process.env.PORT || 3002;
app.listen(PORT, async () => {
  try {
    await refreshTasksGaugeFromDb();
  } catch (err) {
    logger.warn({ err }, "tasks gauge initialization failed");
  }

  logger.info({ port: PORT }, "task-service started");
});

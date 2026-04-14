require("./tracing");
const {
  register,
  httpRequestsTotal,
  httpRequestDurationMs,
  upstreamErrorsTotal,
} = require("./metrics");
const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");
const pino = require("pino");
const pinoHttp = require("pino-http");
const authMiddleware = require("./auth");

const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const app = express();

const USER_SERVICE_URL =
  process.env.USER_SERVICE_URL || "http://localhost:3001";
const TASK_SERVICE_URL =
  process.env.TASK_SERVICE_URL || "http://localhost:3002";
const NOTIFICATION_SERVICE_URL =
  process.env.NOTIFICATION_SERVICE_URL || "http://localhost:3003";

const ERROR_CODE = 500;

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

function createUpstreamProxy(serviceName, target, rewritePrefix, rewriteTo) {
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    pathRewrite: { [rewritePrefix]: rewriteTo },
    on: {
      proxyRes: (proxyRes) => {
        if (proxyRes.statusCode === 502) {
          upstreamErrorsTotal.labels(serviceName).inc();
        }
      },
      error: (err, req, res) => {
        upstreamErrorsTotal.labels(serviceName).inc();
        logger.error({ err }, `${serviceName} proxy error`);
        res.status(502).json({ error: `${serviceName} unavailable` });
      },
    },
  });
}

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
  res.json({
    status: "ok",
    service: "api-gateway",
    upstream: { USER_SERVICE_URL, TASK_SERVICE_URL, NOTIFICATION_SERVICE_URL },
  }),
);

app.get("/metrics", async (req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

app.use(authMiddleware);

app.use(
  "/api/users",
  createUpstreamProxy(
    "user-service",
    USER_SERVICE_URL,
    "^/api/users",
    "/users",
  ),
);

app.use(
  "/api/tasks",
  createUpstreamProxy(
    "task-service",
    TASK_SERVICE_URL,
    "^/api/tasks",
    "/tasks",
  ),
);

app.use(
  "/api/notifications",
  createUpstreamProxy(
    "notification-service",
    NOTIFICATION_SERVICE_URL,
    "^/api/notifications",
    "/notifications",
  ),
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info({ port: PORT }, "api-gateway started");
});

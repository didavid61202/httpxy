import httpNative from "node:http";
import httpsNative from "node:https";
import { getPort, hasEncryptedConnection, setupOutgoing } from "../_utils";
import { webOutgoingMiddleware } from "./web-outgoing";
import { ProxyMiddleware, defineProxyMiddleware } from "./_utils";

const nativeAgents = { http: httpNative, https: httpsNative };

/**
 * Sets `content-length` to '0' if request is of DELETE type.
 */
const deleteLength = defineProxyMiddleware((req) => {
  if (
    (req.method === "DELETE" || req.method === "OPTIONS") &&
    !req.headers["content-length"]
  ) {
    req.headers["content-length"] = "0";
    delete req.headers["transfer-encoding"];
  }
});

/**
 * Sets timeout in request socket if it was specified in options.
 */
const timeout = defineProxyMiddleware((req, res, options) => {
  if (options.timeout) {
    req.socket.setTimeout(options.timeout);
  }
});

/**
 * Sets `x-forwarded-*` headers if specified in config.
 */
const XHeaders = defineProxyMiddleware((req, res, options) => {
  if (!options.xfwd) {
    return;
  }

  const encrypted = (req as any).isSpdy || hasEncryptedConnection(req);
  const values = {
    for: req.connection.remoteAddress || req.socket.remoteAddress,
    port: getPort(req),
    proto: encrypted ? "https" : "http",
  };

  for (const header of ["for", "port", "proto"]) {
    req.headers["x-forwarded-" + header] =
      (req.headers["x-forwarded-" + header] || "") +
      (req.headers["x-forwarded-" + header] ? "," : "") +
      values[header];
  }

  req.headers["x-forwarded-host"] =
    req.headers["x-forwarded-host"] || req.headers.host || "";
});

/**
 * Does the actual proxying. If `forward` is enabled fires up
 * a ForwardStream, same happens for ProxyStream. The request
 * just dies otherwise.
 *
 */
const stream = defineProxyMiddleware(
  (req, res, options, server, head, callback) => {
    // And we begin!
    server.emit("start", req, res, options.target || options.forward);

    // const agents = options.followRedirects ? followRedirects : nativeAgents;
    const agents = nativeAgents;
    const http = agents.http;
    const https = agents.https;

    if (options.forward) {
      // If forward enable, so just pipe the request
      const forwardReq = (
        options.forward.protocol === "https:" ? https : http
      ).request(setupOutgoing(options.ssl || {}, options, req, "forward"));

      // error handler (e.g. ECONNRESET, ECONNREFUSED)
      // Handle errors on incoming request as well as it makes sense to
      const forwardError = createErrorHandler(forwardReq, options.forward);
      req.on("error", forwardError);
      forwardReq.on("error", forwardError);

      (options.buffer || req).pipe(forwardReq);
      if (!options.target) {
        res.end();
        return;
      }
    }

    // Request initalization
    const proxyReq = (
      options.target.protocol === "https:" ? https : http
    ).request(setupOutgoing(options.ssl || {}, options, req));

    // Enable developers to modify the proxyReq before headers are sent
    proxyReq.on("socket", (socket) => {
      if (server && !proxyReq.getHeader("expect")) {
        server.emit("proxyReq", proxyReq, req, res, options);
      }
    });

    // allow outgoing socket to timeout so that we could
    // show an error page at the initial request
    if (options.proxyTimeout) {
      proxyReq.setTimeout(options.proxyTimeout, function () {
        proxyReq.abort();
      });
    }

    // Ensure we abort proxy if request is aborted
    req.on("aborted", function () {
      proxyReq.abort();
    });

    // handle errors in proxy and incoming request, just like for forward proxy
    const proxyError = createErrorHandler(proxyReq, options.target);
    req.on("error", proxyError);
    proxyReq.on("error", proxyError);

    function createErrorHandler(proxyReq, url) {
      return function proxyError(err) {
        if (req.socket.destroyed && err.code === "ECONNRESET") {
          server.emit("econnreset", err, req, res, url);
          return proxyReq.abort();
        }

        if (callback) {
          callback(err, req, res, url);
        } else {
          server.emit("error", err, req, res, url);
        }
      };
    }

    (options.buffer || req).pipe(proxyReq);

    proxyReq.on("response", function (proxyRes) {
      if (server) {
        server.emit("proxyRes", proxyRes, req, res);
      }

      if (!res.headersSent && !options.selfHandleResponse) {
        for (const pass of webOutgoingMiddleware) {
          if (pass(req, res, proxyRes, options)) {
            break;
          }
        }
      }

      if (res.finished) {
        if (server) {
          server.emit("end", req, res, proxyRes);
        }
      } else {
        // Allow us to listen when the proxy has completed
        proxyRes.on("end", function () {
          if (server) {
            server.emit("end", req, res, proxyRes);
          }
        });
        // We pipe to the response unless its expected to be handled by the user
        if (!options.selfHandleResponse) {
          proxyRes.pipe(res);
        }
      }
    });
  },
);

export const webIncomingMiddleware: readonly ProxyMiddleware[] = [
  deleteLength,
  timeout,
  XHeaders,
  stream,
] as const;

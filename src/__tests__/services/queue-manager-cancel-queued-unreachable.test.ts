import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";

/**
 * The read has to be able to say "I could not look".
 *
 * `client.getQueue()` cannot. It goes through the vendored client, whose
 * failure path resolves a document with no Running/Pending key, which the
 * `?? []` normalizer turns into an EMPTY QUEUE — measured here against a real
 * HTTP server for a 500, a 502 HTML proxy page, a 200 `{}` and a dead port.
 * Nothing throws.
 *
 * Built on that read, the #1632 fix inverts into a worse bug than the one it
 * replaced: with ComfyUI merely unreachable, a genuinely PENDING job reads as
 * "not pending" → `absent` → "it already finished, its outputs already exist",
 * and the delete is never even attempted (the old code always attempted it).
 * A failed read AFTER the delete is the same collapse pointed the other way:
 * an empty result looks like a successful removal and re-earns the exact
 * "removed successfully." of #1632, now stamped `verified`.
 *
 * So these tests use NO client mock at all — real queue-manager, real
 * client.ts, real fetch, real sockets. A stubbed client is precisely what
 * hides this.
 */

const servers: http.Server[] = [];

async function serve(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return (server.address() as { port: number }).port;
}

/**
 * `config` resolves its target once at module load, so setting COMFYUI_URL here
 * would do nothing. setComfyuiTarget + resetClient is the documented runtime
 * retarget path (the panel orchestrator uses it for the same reason).
 */
async function connect(port: number) {
  const { setComfyuiTarget } = await import("../../config.js");
  const client = await import("../../comfyui/client.js");
  expect(setComfyuiTarget(`http://127.0.0.1:${port}`)).toBe(true);
  client.resetClient();
  return await import("../../services/queue-manager.js");
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

/** A real /queue document with one job pending — what the server really holds. */
const PENDING_BODY = JSON.stringify({
  queue_running: [],
  queue_pending: [[1, "my-job", { "1": { class_type: "SaveImage", inputs: {} } }, {}, []]],
});

describe("cancelQueuedJob when /queue cannot be read", () => {
  it("does not call a live pending job 'absent' when a proxy answers HTML", async () => {
    const seen: string[] = [];
    const port = await serve((req, res) => {
      seen.push(`${req.method} ${req.url?.split("?")[0]}`);
      if (req.url?.startsWith("/queue") && req.method === "GET") {
        res.writeHead(502, { "content-type": "text/html" });
        res.end("<html><body>502 Bad Gateway</body></html>");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    const { cancelQueuedJob } = await connect(port);

    const result = await cancelQueuedJob("my-job");

    expect(result.state).not.toBe("absent");
    expect(result.verified).toBe(false);
    // The delete must still be ATTEMPTED — an unreadable queue is not grounds
    // for silently doing nothing, which is what the absent short-circuit did.
    expect(seen).toContain("POST /queue");
  });

  it("does not report a removal it could not see after the delete", async () => {
    let queueReads = 0;
    const port = await serve((req, res) => {
      if (req.url?.startsWith("/queue") && req.method === "GET") {
        queueReads += 1;
        if (queueReads === 1) {
          // Before: the job really is pending.
          res.writeHead(200, { "content-type": "application/json" });
          res.end(PENDING_BODY);
          return;
        }
        // After: the read fails. An empty answer here is what used to read as
        // "gone, therefore removed".
        res.writeHead(502, { "content-type": "text/html" });
        res.end("<html><body>502 Bad Gateway</body></html>");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    const { cancelQueuedJob } = await connect(port);

    const result = await cancelQueuedJob("my-job");

    expect(result.verified).toBe(false);
    expect(queueReads).toBe(2);
  });

  it("attempts the delete rather than short-circuiting when ComfyUI is down", async () => {
    const port = await serve(() => {});
    await new Promise<void>((r) => servers[servers.length - 1].close(() => r()));
    servers.pop();
    const { cancelQueuedJob } = await connect(port);

    // Nothing is listening, so the delete itself fails — which is honest. What
    // must NOT happen is a resolved `{state:"absent"}` claiming the job
    // finished, which is what an empty-on-failure read produced.
    await expect(cancelQueuedJob("my-job")).rejects.toThrow();
  });

  it("still verifies normally against a healthy server", async () => {
    let queueReads = 0;
    let deleted = false;
    const port = await serve((req, res) => {
      if (req.url?.startsWith("/queue") && req.method === "GET") {
        queueReads += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(deleted ? JSON.stringify({ queue_running: [], queue_pending: [] }) : PENDING_BODY);
        return;
      }
      if (req.url?.startsWith("/queue") && req.method === "POST") {
        deleted = true;
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    const { cancelQueuedJob } = await connect(port);

    await expect(cancelQueuedJob("my-job")).resolves.toEqual({
      removed: true,
      state: "removed",
      verified: true,
    });
    expect(queueReads).toBe(2);
  });

  it("reports a job that is genuinely absent from a healthy server", async () => {
    const port = await serve((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ queue_running: [], queue_pending: [] }));
    });
    const { cancelQueuedJob } = await connect(port);

    await expect(cancelQueuedJob("my-job")).resolves.toEqual({
      removed: false,
      state: "absent",
      verified: true,
    });
  });
});

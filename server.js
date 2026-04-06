const path = require("path");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const mqtt = require("mqtt");
require("dotenv").config();

const PORT = Number(process.env.PORT || 8080);
const RELAY_TOKEN = process.env.RELAY_TOKEN || "";
const MQTT_URL = process.env.MQTT_URL || "mqtt://broker.hivemq.com:1883";
const MQTT_USERNAME = process.env.MQTT_USERNAME || "";
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || "";
const MQTT_CMD_TOPIC = process.env.MQTT_CMD_TOPIC || "neckremote/demo1/cmd";
const MQTT_STATUS_TOPIC = process.env.MQTT_STATUS_TOPIC || "neckremote/demo1/status";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "";
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60 * 1000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 30);
const ONLINE_TIMEOUT_MS = Number(process.env.ONLINE_TIMEOUT_MS || 30000);
const MAX_NECK_ID = Number(process.env.MAX_NECK_ID || 30);
const NECK_COUNT = MAX_NECK_ID + 1;

if (!RELAY_TOKEN) {
  console.warn("[WARN] RELAY_TOKEN is empty. Set RELAY_TOKEN in .env before production.");
}

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "16kb" }));

if (ALLOWED_ORIGIN) {
  app.use(cors({ origin: ALLOWED_ORIGIN }));
}

const sendLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false
});

let mqttConnected = false;
let lastStatus = "";
let lastStatusTs = 0;
const neckStates = Array.from({ length: NECK_COUNT }, (_, id) => ({
  id,
  state: -1,
  ts: 0
}));

function updateNeckState(id, state, tsMs = Date.now(), touchTs = true) {
  if (!Number.isInteger(id) || id < 0 || id > MAX_NECK_ID) return;
  if (!Number.isInteger(state) || state < -1 || state > 6) return;
  neckStates[id].state = state;
  if (touchTs) {
    neckStates[id].ts = tsMs;
  }
}

function updateAllNeckStates(state, tsMs = Date.now(), touchTs = true) {
  for (let i = 0; i < NECK_COUNT; i++) {
    updateNeckState(i, state, tsMs, touchTs);
  }
}

function parseAndApplyStatus(payloadText, tsMs) {
  const txt = (payloadText || "").trim();
  if (!txt) return;

  if (txt.startsWith("{") && txt.endsWith("}")) {
    try {
      const j = JSON.parse(txt);
      if (Number.isInteger(j.id) && Number.isInteger(j.state)) {
        const t = Number.isInteger(j.ts) ? j.ts : tsMs;
        updateNeckState(j.id, j.state, t);
        return;
      }
      if (Number.isInteger(j.target) && Number.isInteger(j.state)) {
        const t = Number.isInteger(j.ts) ? j.ts : tsMs;
        updateNeckState(j.target, j.state, t);
        return;
      }
      if (j.target === "all" && Number.isInteger(j.state)) {
        // "all" 多半是發信器發送紀錄，不代表每顆頸圈都回報在線
        updateAllNeckStates(j.state, tsMs, false);
        return;
      }
    } catch {
      // ignore invalid JSON
    }
  }

  // CSV fallback: ACK,<id>,<state>,...
  // or: STATE,<id>,<state>,<ts>
  const parts = txt.split(",").map((s) => s.trim());
  if (parts.length >= 3 && (parts[0] === "ACK" || parts[0] === "STATE")) {
    const id = Number(parts[1]);
    const state = Number(parts[2]);
    const t = parts.length >= 4 && Number.isFinite(Number(parts[3])) ? Number(parts[3]) : tsMs;
    updateNeckState(id, state, t);
  }
}

const mqttClient = mqtt.connect(MQTT_URL, {
  username: MQTT_USERNAME || undefined,
  password: MQTT_PASSWORD || undefined,
  reconnectPeriod: 3000
});

mqttClient.on("connect", () => {
  mqttConnected = true;
  console.log(`[MQTT] connected: ${MQTT_URL}`);
  mqttClient.subscribe(MQTT_STATUS_TOPIC, (err) => {
    if (err) {
      console.error("[MQTT] subscribe status failed:", err.message);
      return;
    }
    console.log(`[MQTT] subscribed: ${MQTT_STATUS_TOPIC}`);
  });
});

mqttClient.on("reconnect", () => {
  console.log("[MQTT] reconnecting...");
});

mqttClient.on("close", () => {
  mqttConnected = false;
});

mqttClient.on("error", (err) => {
  console.error("[MQTT] error:", err.message);
});

mqttClient.on("message", (topic, payload) => {
  if (topic !== MQTT_STATUS_TOPIC) {
    return;
  }
  lastStatus = payload.toString();
  lastStatusTs = Date.now();
  parseAndApplyStatus(lastStatus, lastStatusTs);
});

function auth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const token = bearer || req.headers["x-relay-token"] || "";

  if (!RELAY_TOKEN || token !== RELAY_TOKEN) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

function buildPayload(body) {
  if (typeof body.payload === "string" && body.payload.trim()) {
    return body.payload.trim();
  }

  const state = Number(body.state);
  if (!Number.isInteger(state) || state < 0 || state > 6) {
    return null;
  }

  if (body.target === "all") {
    return `A,${state}`;
  }

  const neck = Number(body.target);
  if (!Number.isInteger(neck) || neck < 0 || neck > MAX_NECK_ID) {
    return null;
  }
  return `${neck},${state}`;
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    mqttConnected,
    cmdTopic: MQTT_CMD_TOPIC,
    statusTopic: MQTT_STATUS_TOPIC,
    now: Date.now()
  });
});

app.get("/api/status", auth, (_req, res) => {
  const now = Date.now();
  res.json({
    ok: true,
    mqttConnected,
    cmdTopic: MQTT_CMD_TOPIC,
    statusTopic: MQTT_STATUS_TOPIC,
    lastStatus,
    lastStatusTs,
    onlineTimeoutMs: ONLINE_TIMEOUT_MS,
    neckStates: neckStates.map((n) => ({
      id: n.id,
      state: n.state,
      ts: n.ts,
      online: n.ts > 0 && now - n.ts < ONLINE_TIMEOUT_MS
    }))
  });
});

app.post("/api/send", sendLimiter, auth, (req, res) => {
  if (!mqttConnected) {
    return res.status(503).json({ ok: false, error: "mqtt_disconnected" });
  }

  const payload = buildPayload(req.body || {});
  if (!payload) {
    return res.status(400).json({ ok: false, error: "invalid_payload" });
  }

  mqttClient.publish(MQTT_CMD_TOPIC, payload, { qos: 0, retain: false }, (err) => {
    if (err) {
      return res.status(500).json({ ok: false, error: "publish_failed" });
    }
    const now = Date.now();
    if (/^A,\d$/.test(payload)) {
      const st = Number(payload.split(",")[1]);
      // 下發命令僅更新預期狀態，不更新在線時間(ts)
      updateAllNeckStates(st, now, false);
    } else if (/^\d{1,2},\d$/.test(payload)) {
      const [idText, stText] = payload.split(",");
      // 下發命令僅更新預期狀態，不更新在線時間(ts)
      updateNeckState(Number(idText), Number(stText), now, false);
    }
    return res.json({ ok: true, payload });
  });
});

app.use("/", express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`[HTTP] relay listening on :${PORT}`);
});

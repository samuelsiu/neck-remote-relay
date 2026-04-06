# Neck Remote Cloud Relay (Formal Version)

This service provides:

- Secure web control page
- Authenticated API
- MQTT publish bridge to your ESP32 topic
- MQTT status subscription

Architecture:

`Web page -> Relay API -> MQTT broker -> ESP32`

## 1) Install and run

```bash
cd relay-server
npm install
copy .env.example .env
```

Edit `.env`:

- `RELAY_TOKEN`: set a strong random secret
- `MQTT_CMD_TOPIC`: must match ESP32 subscribe topic (`.../cmd`)
- `MQTT_STATUS_TOPIC`: must match ESP32 status topic (`.../status`)
- Optional broker username/password

Run:

```bash
npm start
```

Open:

- `http://localhost:8080/`

## 2) ESP32 side alignment

On ESP32 Serial:

- `CLOUDCFG <host> <port> <baseTopic> [user] [pass]`
- `CLOUDON`
- `CLOUDTRY`

If ESP32 base topic is `neckremote/demo1`, then:

- cmd topic = `neckremote/demo1/cmd`
- status topic = `neckremote/demo1/status`

Use the same topics in `.env`.

## 3) API

- `GET /api/health` (public)
- `GET /api/status` (requires Bearer token)
- `POST /api/send` (requires Bearer token)

`POST /api/send` body examples:

```json
{ "target": "all", "state": 1 }
```

```json
{ "target": 3, "state": 6 }
```

```json
{ "payload": "A,1" }
```

## 4) Production checklist

- Set a long `RELAY_TOKEN`
- Set `ALLOWED_ORIGIN` to your web domain
- Use private MQTT broker credentials
- Consider TLS MQTT (`mqtts://...`)
- Keep topic names unique

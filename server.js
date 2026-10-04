require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = Number(process.env.PORT || 3000);
const AI_API_KEY = process.env.AI_API_KEY || "";
const AI_API_URL = process.env.AI_API_URL || "";
const AI_MODEL = process.env.AI_MODEL || "";

const QUOTA_MAX = Math.max(1, Number(process.env.QUOTA_MAX || 30));
const REFILL_MIN = Math.max(1, Number(process.env.REFILL_MINUTES_MIN || 20));
const REFILL_MAX = Math.max(REFILL_MIN, Number(process.env.REFILL_MINUTES_MAX || 60));

/*
  V1 sederhana:
  - Konteks percakapan dikirim dari Gexa melalui "pesan".
  - API key AI hanya berada di server.
  - Kuota dihitung per alamat IP.
  - Saat kuota habis, waktu refill dibuat acak.
  - Ini adalah kuota aplikasi Gexa, bukan "token gratis" dari provider AI.
*/
const users = new Map();

function getClientId(req) {
  const forwarded = req.headers["x-forwarded-for"];
  return String(forwarded ? forwarded.split(",")[0].trim() : req.ip);
}

function getQuota(clientId) {
  const now = Date.now();
  let q = users.get(clientId);

  if (!q) {
    q = {
      remaining: QUOTA_MAX,
      refillAt: 0
    };
    users.set(clientId, q);
  }

  if (q.remaining <= 0 && q.refillAt && now >= q.refillAt) {
    q.remaining = QUOTA_MAX;
    q.refillAt = 0;
  }

  return q;
}

function useQuota(clientId) {
  const q = getQuota(clientId);

  if (q.remaining <= 0) {
    return {
      ok: false,
      remaining: 0,
      refillAt: q.refillAt
    };
  }

  q.remaining -= 1;

  if (q.remaining === 0) {
    const minutes =
      Math.floor(Math.random() * (REFILL_MAX - REFILL_MIN + 1)) + REFILL_MIN;
    q.refillAt = Date.now() + minutes * 60 * 1000;
  }

  return {
    ok: true,
    remaining: q.remaining,
    refillAt: q.refillAt
  };
}

function cleanMessages(messages) {
  if (!Array.isArray(messages)) return [];

  return messages
    .filter(m => m && (m.role === "user" || m.role === "assistant"))
    .map(m => ({
      role: m.role,
      content: String(m.content || "").slice(0, 20000)
    }))
    .slice(-50);
}

function buildSystemPrompt(body) {
  const memory = Array.isArray(body.memori)
    ? body.memori.map(x => String(x)).slice(0, 30).join("\n")
    : "";

  const instruction = String(body.instruksi || "").slice(0, 10000);

  return [
    "Kamu adalah AI assistant di aplikasi Gexa.",
    "Jawab dengan jelas, membantu, dan sesuai bahasa pengguna.",
    instruction ? `Instruksi khusus pengguna:\n${instruction}` : "",
    memory ? `Memori pengguna:\n${memory}` : ""
  ].filter(Boolean).join("\n\n");
}

async function callAI(body) {
  if (!AI_API_KEY || !AI_API_URL || !AI_MODEL) {
    throw new Error(
      "Backend belum dikonfigurasi. Isi AI_API_KEY, AI_API_URL, dan AI_MODEL di file .env."
    );
  }

  const messages = [
    { role: "system", content: buildSystemPrompt(body) },
    ...cleanMessages(body.pesan)
  ];

  const response = await fetch(AI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${AI_API_KEY}`
    },
    body: JSON.stringify({
      model: AI_MODEL,
      messages,
      temperature: 0.7
    })
  });

  const raw = await response.text();

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Provider AI mengirim respons bukan JSON (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    const detail =
      data?.error?.message ||
      data?.message ||
      `Provider AI error (HTTP ${response.status})`;
    throw new Error(detail);
  }

  // Format OpenAI-compatible.
  const text =
    data?.choices?.[0]?.message?.content ??
    data?.choices?.[0]?.text ??
    data?.output_text ??
    data?.text;

  if (!text) {
    throw new Error("Jawaban AI tidak ditemukan pada respons provider.");
  }

  return String(text);
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    name: "Gexa Backend V1",
    status: "online"
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/quota", (req, res) => {
  const id = getClientId(req);
  const q = getQuota(id);

  res.json({
    remaining: q.remaining,
    max: QUOTA_MAX,
    refillAt: q.refillAt || null
  });
});

app.post("/chat", async (req, res) => {
  try {
    const body = req.body || {};
    const clientId = getClientId(req);

    if (!Array.isArray(body.pesan) || body.pesan.length === 0) {
      return res.status(400).json({
        error: "Pesan chat kosong."
      });
    }

    const quota = useQuota(clientId);

    if (!quota.ok) {
      return res.status(429).json({
        error: "Kuota Gexa habis.",
        remaining: 0,
        refillAt: quota.refillAt
      });
    }

    const text = await callAI(body);

    res.json({
      text,
      quota: {
        remaining: quota.remaining,
        max: QUOTA_MAX,
        refillAt: quota.refillAt || null
      }
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: err.message || "Terjadi kesalahan pada backend."
    });
  }
});

app.listen(PORT, () => {
  console.log(`Gexa Backend V1 berjalan di http://localhost:${PORT}`);
});

import express from "express";
import cors from "cors";
import multer from "multer";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors({ origin: "*" }));
app.use(express.json());

console.log("Starting Mosquito API server...");

// DJI Thermal SDK typicky vrací hodnoty jako "°C * 10"
const DEFAULT_SCALE = 0.1; // °C = raw * 0.1

app.get("/", (req, res) => {
  res.send("DJI Thermal API running on Cloud Run 🚀");
});

function parseBool(v) {
  if (typeof v !== "string") return false;
  return v.toLowerCase() === "true";
}

function parseIntOrNull(v) {
  if (typeof v === "undefined" || v === null || v === "") return null;
  const n = parseInt(v, 10);
  return Number.isInteger(n) ? n : null;
}

app.post("/extract-thermal", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Missing file 'image'." });
    }

    // Volitelné parametry:
    // x,y → vrátí teplotu bodu (bez celé matice)
    // include_raw_data=true → pošle base64 matici
    // format=int16|float32 (default int16)
    // scale=0.1 (default 0.1) - použije se pro int16 interpretaci na klientovi
    const xRaw = req.body?.x ?? req.query?.x;
    const yRaw = req.body?.y ?? req.query?.y;

    const includeRawFlag = req.body?.include_raw_data ?? req.query?.include_raw_data;
    const formatRaw = req.body?.format ?? req.query?.format; // "int16" | "float32"
    const scaleRaw = req.body?.scale ?? req.query?.scale;   // např. "0.1"

    const includeRawData = parseBool(includeRawFlag);

    const x = parseIntOrNull(xRaw);
    const y = parseIntOrNull(yRaw);
    const hasCoords = x !== null && y !== null;

    const format = (typeof formatRaw === "string" ? formatRaw.toLowerCase() : "int16");
    const scale = (typeof scaleRaw === "string" && scaleRaw.trim() !== "")
      ? Number(scaleRaw)
      : DEFAULT_SCALE;

    if (!Number.isFinite(scale) || scale <= 0) {
      return res.status(400).json({ error: "Invalid 'scale'. Must be a positive number (e.g. 0.1)." });
    }

    let djiModule;
    try {
      djiModule = await import("dji-thermal-sdk");
    } catch (err) {
      console.error("Failed to load dji-thermal-sdk:", err);
      return res.status(500).json({
        error: "Failed to load dji-thermal-sdk on the server.",
        details: err?.message || String(err),
      });
    }

    const { getTemperatureData } = djiModule.default || djiModule;

    const buffer = req.file.buffer;
    const { width, height, parameters, data } = getTemperatureData(buffer);

    if (!data || data.length === 0) {
      return res.status(500).json({
        error: "No thermal data returned – is this really DJI R-JPEG?",
      });
    }

    // Bezpečnost: rozměry musí sedět
    if (width * height !== data.length) {
      console.warn("Thermal data length mismatch:", { width, height, len: data.length });
    }

    // Pokud máme x,y → vrať jen teplotu bodu (bez base64 matice)
    if (hasCoords) {
      if (x < 0 || x >= width || y < 0 || y >= height) {
        return res.status(400).json({
          error: "Coordinates out of bounds.",
          width,
          height,
        });
      }

      const idx = y * width + x;
      const raw = data[idx];

      // ošetři no-data/saturaci
      if (raw === 0 || raw === 65535) {
        return res.json({
          temperature: null,
          reason: "no-data-or-saturated",
          x,
          y,
          width,
          height,
        });
      }

      const tempC = raw * scale;
      console.log(`Pixel temperature [${x},${y}] = ${tempC}°C (raw=${raw}, scale=${scale})`);

      return res.json({
        temperature: tempC,
        raw,
        scale,
        x,
        y,
        width,
        height,
      });
    }

    // Statistika bez velkých polí
    let minRaw = Infinity;
    let maxRaw = -Infinity;
    let sumRaw = 0;
    let count = 0;

    for (let i = 0; i < data.length; i++) {
      const raw = data[i];
      if (raw === 0 || raw === 65535 || !Number.isFinite(raw)) continue;
      if (raw < minRaw) minRaw = raw;
      if (raw > maxRaw) maxRaw = raw;
      sumRaw += raw;
      count++;
    }

    if (count === 0) {
      return res.status(500).json({
        error: "No valid thermal samples for statistics.",
      });
    }

    const avgRaw = sumRaw / count;

    const minC = minRaw * scale;
    const maxC = maxRaw * scale;
    const avgC = avgRaw * scale;

    // Najdi pixel pozice min/max (volitelně užitečné pro overlay)
    let minIndex = -1;
    let maxIndex = -1;
    for (let i = 0; i < data.length; i++) {
      const raw = data[i];
      if (raw === 0 || raw === 65535) continue;
      if (raw === minRaw && minIndex === -1) minIndex = i;
      if (raw === maxRaw && maxIndex === -1) maxIndex = i;
      if (minIndex !== -1 && maxIndex !== -1) break;
    }

    const minPixel = minIndex >= 0 ? { x: minIndex % width, y: Math.floor(minIndex / width) } : null;
    const maxPixel = maxIndex >= 0 ? { x: maxIndex % width, y: Math.floor(maxIndex / width) } : null;

    const response = {
      width,
      height,
      parameters, // { emissivity, distance, humidity, reflection } - jak vrací SDK
      stats: {
        minC,
        maxC,
        avgC,
        samples: count,
      },
      minPixel,
      maxPixel,

      // Debug vzorek (malé)
      sampleTempsC: (() => {
        const out = [];
        for (let i = 0, added = 0; i < data.length && added < 50; i++) {
          const raw = data[i];
          if (raw === 0 || raw === 65535) continue;
          out.push(raw * scale);
          added++;
        }
        return out;
      })(),
    };

    // Pokud chceš poslat celou matici → base64
    if (includeRawData) {
      if (format === "float32") {
        // Float32 v °C (větší payload než int16)
        const f32 = new Float32Array(data.length);
        for (let i = 0; i < data.length; i++) f32[i] = data[i] * scale;

        response.temperatures_base64 = Buffer.from(f32.buffer).toString("base64");
        response.temperatures_format = "float32";
        response.temperatures_unit = "C";
      } else {
        // Default: int16 raw (nejmenší)
        // Pozor: data může být Uint16; přetypujeme do Int16 jen kvůli transportu,
        // hodnoty do ~65535 se do int16 nevejdou, ale my stejně filtrujeme 65535 jako saturaci.
        // Pokud chceš 100% bezpečně pro celé rozsahy, použij radši Uint16 a na klientovi Uint16Array.
        // DJI raw bývá v rozumných mezích, ale pokud chceš jistotu, přepni na uint16 (viz komentář níže).

        // ✅ Doporučená „safe“ varianta: posílat uint16
        const u16 = new Uint16Array(data.length);
        for (let i = 0; i < data.length; i++) u16[i] = data[i];

        response.temperatures_base64 = Buffer.from(u16.buffer).toString("base64");
        response.temperatures_format = "uint16";
        response.temperatures_scale = scale; // °C = raw * scale
        response.temperatures_unit = "C";
      }
    }

    return res.json(response);
  } catch (err) {
    console.error("Error in /extract-thermal handler:", err);
    return res.status(500).json({
      error: "Processing failed",
      details: err?.message || String(err),
    });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("Mosquito API listening on port", PORT);
});

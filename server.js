import express from "express";
import cors from "cors";
import multer from "multer";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors({ origin: "*" }));
app.use(express.json());

console.log("Starting Mosquito API server...");

// DJI Thermal SDK typicky vrací raw jako "°C * 10" => scale = 0.1
const DEFAULT_SCALE = 0.1;

app.get("/", (_req, res) => {
  res.type("text/plain").send("DJI Thermal API running on Cloud Run 🚀");
});

function parseIntOrNull(v) {
  if (typeof v === "undefined" || v === null || v === "") return null;
  const n = parseInt(v, 10);
  return Number.isInteger(n) ? n : null;
}

function parseScale(v) {
  if (typeof v !== "string" || v.trim() === "") return DEFAULT_SCALE;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * POST /extract-thermal
 * multipart/form-data:
 *  - image: DJI R-JPEG file
 * optional:
 *  - x, y (ints) -> return one pixel temperature as JSON
 *  - scale (number) -> default 0.1
 *
 * Default (no x,y):
 *  - returns application/octet-stream with raw uint16 matrix
 *  - headers: X-Width, X-Height, X-Scale, X-Format=uint16, X-Unit=C
 */
app.post("/extract-thermal", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Missing file 'image'." });
    }

    const xRaw = req.body?.x ?? req.query?.x;
    const yRaw = req.body?.y ?? req.query?.y;
    const scaleRaw = req.body?.scale ?? req.query?.scale;

    const x = parseIntOrNull(xRaw);
    const y = parseIntOrNull(yRaw);
    const hasCoords = x !== null && y !== null;

    const scale = parseScale(typeof scaleRaw === "string" ? scaleRaw : "");
    if (scale === null) {
      return res
        .status(400)
        .json({ error: "Invalid 'scale'. Must be a positive number (e.g. 0.1)." });
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

    // MODE 1: single pixel (JSON)
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

      if (raw === 0 || raw === 65535) {
        return res.json({
          temperature: null,
          reason: "no-data-or-saturated",
          x,
          y,
          width,
          height,
          scale,
        });
      }

      return res.json({
        temperature: raw * scale,
        raw,
        x,
        y,
        width,
        height,
        scale,
        parameters,
      });
    }

    // MODE 2: full matrix (binary uint16)
    const u16 = new Uint16Array(data.length);
    for (let i = 0; i < data.length; i++) u16[i] = data[i];

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("X-Width", String(width));
    res.setHeader("X-Height", String(height));
    res.setHeader("X-Scale", String(scale));
    res.setHeader("X-Format", "uint16");
    res.setHeader("X-Unit", "C");

    // Pokud chceš, můžeš parametry poslat jako JSON string v headeru (malé):
    // res.setHeader("X-Params", JSON.stringify(parameters ?? {}));

    return res.send(Buffer.from(u16.buffer));
  } catch (err) {
    console.error("Error in /extract-thermal:", err);
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

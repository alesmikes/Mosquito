import express from "express";
import cors from "cors";
import multer from "multer";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors({ origin: "*" }));
app.use(express.json());

console.log("Starting Mosquito API server...");

app.get("/", (req, res) => {
  res.send("DJI Thermal API running on Cloud Run 🚀");
});

app.post("/extract-thermal", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Missing file 'image'." });
    }

    // Volitelné parametry z multipart/form-data (nebo query)
    const xRaw = req.body?.x ?? req.query?.x;
    const yRaw = req.body?.y ?? req.query?.y;
    const includeRawFlag =
      req.body?.include_raw_data ?? req.query?.include_raw_data;

    const hasCoords =
      typeof xRaw !== "undefined" &&
      xRaw !== "" &&
      typeof yRaw !== "undefined" &&
      yRaw !== "";

    const includeRawData =
      typeof includeRawFlag === "string" &&
      includeRawFlag.toLowerCase() === "true";

    let x = null;
    let y = null;

    if (hasCoords) {
      x = parseInt(xRaw, 10);
      y = parseInt(yRaw, 10);

      if (!Number.isInteger(x) || !Number.isInteger(y)) {
        return res.status(400).json({
          error: "Invalid coordinates; x and y must be integers.",
        });
      }
    }

    let djiModule;
    try {
      djiModule = await import("dji-thermal-sdk");
    } catch (err) {
      console.error("Failed to load dji-thermal-sdk:", err);
      return res.status(500).json({
        error: "Failed to load dji-thermal-sdk on the server.",
        details: err.message,
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

    // Převod všech hodnot do °C
    const temperaturesC = Array.from(data, (v) => v / 10);

    // 🔵 REŽIM 1: pokud máme x,y → vrať jen teplotu bodu
    if (hasCoords) {
      if (x < 0 || x >= width || y < 0 || y >= height) {
        return res.status(400).json({
          error: "Coordinates out of bounds.",
          width,
          height,
        });
      }

      const idx = y * width + x;
      const tempC = temperaturesC[idx];

      console.log(`Pixel temperature [${x},${y}] = ${tempC}°C`);

      return res.json({
        temperature: tempC,
        x,
        y,
      });
    }

    // 🟢 REŽIM 2: globální statistika pro celou fotku (bez outlier triků)
    let minC = Infinity;
    let maxC = -Infinity;
    let sumC = 0;
    let count = 0;

    for (let i = 0; i < temperaturesC.length; i++) {
      const raw = data[i];
      const t = temperaturesC[i];

      // ignoruj jen zjevné no-data/saturaci
      if (raw === 0 || raw === 65535 || !Number.isFinite(t)) continue;

      if (t < minC) minC = t;
      if (t > maxC) maxC = t;
      sumC += t;
      count++;
    }

    if (count === 0) {
      return res.status(500).json({
        error: "No valid thermal samples for statistics.",
      });
    }

    const avgC = sumC / count;

    const response = {
      width,
      height,
      parameters, // { emissivity, distance, humidity, reflection }
      stats: {
        minC,
        maxC,
        avgC,
        samples: count,
      },
      sampleTempsC: temperaturesC.slice(0, 50),
    };

    if (includeRawData) {
      // 1D pole, index = y * width + x
      response.temperaturesC = temperaturesC;
    }

    return res.json(response);
  } catch (err) {
    console.error("Error in /extract-thermal handler:", err);
    return res.status(500).json({
      error: "Processing failed",
      details: err.message,
    });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("Mosquito API listening on port", PORT);
});

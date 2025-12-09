import express from "express";
import cors from "cors";
import multer from "multer";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors({ origin: "*" }));

console.log("Starting Mosquito API server...");

app.get("/", (req, res) => {
  res.send("DJI Thermal API running on Cloud Run 🚀");
});

app.post("/extract-thermal", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Missing file 'image'." });
    }

    // Zkusíme si vzít x, y, emissivity z formuláře (multipart/form-data)
    const xRaw = req.body?.x ?? req.query?.x;
    const yRaw = req.body?.y ?? req.query?.y;
    const emissivityRaw = req.body?.emissivity ?? req.query?.emissivity;

    const x =
      typeof xRaw === "string" && xRaw !== "" ? parseInt(xRaw, 10) : null;
    const y =
      typeof yRaw === "string" && yRaw !== "" ? parseInt(yRaw, 10) : null;
    const emissivityOverride =
      typeof emissivityRaw === "string" && emissivityRaw !== ""
        ? parseFloat(emissivityRaw)
        : null;

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

    // Globální statistika (necháme jak byla)
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;

    for (const v of data) {
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }

    const avg = sum / data.length;

    // 🔥 Výpočet teploty konkrétního pixelu, pokud máme x,y
    let pixelInfo = null;

    if (
      Number.isInteger(x) &&
      Number.isInteger(y) &&
      x >= 0 &&
      x < width &&
      y >= 0 &&
      y < height
    ) {
      const idx = y * width + x; // řádek po řádku
      const tempRaw = data[idx]; // 0.1 °C jednotky
      const tempC = tempRaw / 10;

      pixelInfo = {
        x,
        y,
        tempRaw,
        tempC,
        // co backend opravdu použil za emisivitu (buď override, nebo z parametru souboru)
        emissivityUsed:
          emissivityOverride ??
          (parameters && parameters.emissivity) ??
          null,
      };
    }

    res.json({
      width,
      height,
      parameters,
      stats: {
        minRaw: min,
        maxRaw: max,
        avgRaw: avg,
        minC: min / 10,
        maxC: max / 10,
        avgC: avg / 10,
      },
      sampleTempsC: Array.from(data.slice(0, 50)).map((x) => x / 10),
      // 🔥 nový objekt s teplotou konkrétního bodu
      pixel: pixelInfo,
    });
  } catch (err) {
    console.error("Error in /extract-thermal handler:", err);
    res.status(500).json({
      error: "Processing failed",
      details: err.message,
    });
  }
});


const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("Mosquito API listening on port", PORT);
});

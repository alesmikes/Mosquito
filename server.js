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

    // 🔥 DŮLEŽITÉ: lazy import dji-thermal-sdk, aby při problému nespadl celý server
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

    let min = Infinity;
    let max = -Infinity;
    let sum = 0;

    for (const v of data) {
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }

    const avg = sum / data.length;

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

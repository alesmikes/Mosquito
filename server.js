import express from "express";
import cors from "cors";
import multer from "multer";
import { getTemperatureData } from "dji-thermal-sdk";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors({ origin: "*" }));

app.get("/", (req, res) => {
  res.send("DJI Thermal API running on Cloud Run 🚀");
});

app.post("/extract-thermal", upload.single("image"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Missing file 'image'." });
    }

    const buffer = req.file.buffer;
    const { width, height, parameters, data } = getTemperatureData(buffer);

    if (!data || data.length === 0) {
      return res.status(500).json({
        error: "No thermal data returned – is this really DJI R-JPEG?"
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
        avgC: avg / 10
      },
      sampleTempsC: Array.from(data.slice(0, 50)).map(x => x / 10)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Processing failed",
      details: err.message
    });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("DJI Thermal API listening on port", PORT));

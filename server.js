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

    // x, y, emissivity z multipart/form-data
    const xRaw = req.body?.x ?? req.query?.x;
    const yRaw = req.body?.y ?? req.query?.y;
    const emissivityRaw = req.body?.emissivity ?? req.query?.emissivity;

    if (typeof xRaw === "undefined" || typeof yRaw === "undefined") {
      return res.status(400).json({
        error: "Missing coordinates 'x' and 'y'.",
      });
    }

    const x = parseInt(xRaw, 10);
    const y = parseInt(yRaw, 10);
    const emissivityOverride =
      typeof emissivityRaw === "string" && emissivityRaw !== ""
        ? parseFloat(emissivityRaw)
        : null;

    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      return res.status(400).json({
        error: "Invalid coordinates; x and y must be integers.",
      });
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

    if (x < 0 || x >= width || y < 0 || y >= height) {
      return res.status(400).json({
        error: "Coordinates out of bounds.",
        width,
        height,
      });
    }

    const idx = y * width + x; // řádek po řádku
    const tempRaw = data[idx]; // 0.1 °C jednotky (typicky)
    const tempC = tempRaw / 10;

    // emise, které backend reálně použil (jen info, klidně to ignoruj)
    const emissivityUsed =
      emissivityOverride ??
      (parameters && parameters.emissivity) ??
      null;

    console.log(
      `Pixel temperature [${x},${y}] = ${tempC}°C (raw=${tempRaw}, emissivity=${emissivityUsed})`
    );

    // 🔥 TADY: přesně to, co Base44 chce
    return res.json({
      temperature: tempC,
      x,
      y,
    });
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

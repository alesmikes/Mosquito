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
    const emissivityRaw = req.body?.emissivity ?? req.query?.emissivity;
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

    // 🟡 REŽIM 1: pokud máme x,y → vrať jen teplotu bodu
    if (hasCoords) {
      if (x < 0 || x >= width || y < 0 || y >= height) {
        return res.status(400).json({
          error: "Coordinates out of bounds.",
          width,
          height,
        });
      }

      const idx = y * width + x; // index v 1D poli (row-major)
      const tempRaw = data[idx]; // v 0.1 °C
      const tempC = tempRaw / 10;

      const emissivityUsed =
        emissivityOverride ??
        (parameters && parameters.emissivity) ??
        null;

      console.log(
        `Pixel temperature [${x},${y}] = ${tempC}°C (raw=${tempRaw}, emissivity=${emissivityUsed})`
      );

      return res.json({
        temperature: tempC,
        x,
        y,
      });
    }

    // 🟢 REŽIM 2: bez x,y → globální statistika pro celou fotku

    // 1) Převést validní pixely na °C a odfiltrovat zjevné nesmysly pro statistiku
    const tempsCForStats = [];

    for (const v of data) {
      // ignoruj no-data / saturaci
      if (v === 0 || v === 65535) continue;

      const t = v / 10; // 0.1 °C -> °C

      // rozumný rozsah – můžeš doladit podle use-case
      if (t < -40 || t > 150) continue;

      tempsCForStats.push(t);
    }

    if (tempsCForStats.length === 0) {
      return res.status(500).json({
        error: "No valid thermal samples for statistics.",
      });
    }

    // 2) Seřadit pro robustní percentilové min/max
    const sorted = [...tempsCForStats].sort((a, b) => a - b);
    const n = sorted.length;

    const p = (q) => {
      // q v [0,1], např. 0.05 = 5. percentil
      if (n === 1) return sorted[0];
      const idx = Math.floor(q * (n - 1));
      return sorted[idx];
    };

    // minC = 5. percentil (ignorujeme úplně nejchladnější marginální pixely)
    const minC = p(0.05);
    // maxC = 99. percentil (ignorujeme extrémní outlier nahoru)
    const maxC = p(0.99);

    // 3) Průměr spočítáme z "ořezaného" rozsahu (mezi 5 % a 99 %)
    let sumC = 0;
    let count = 0;
    for (let i = 0; i < n; i++) {
      const t = sorted[i];
      if (t < minC || t > maxC) continue;
      sumC += t;
      count++;
    }
    const avgC = sumC / count;

    // Základní response
    const response = {
      width,
      height,
      parameters,
      stats: {
        minC,
        maxC,
        avgC,
        samples: n,
        usedForAvg: count,
      },
      sampleTempsC: sorted.slice(0, 50),
    };

    // 🔥 include_raw_data=true → přidej celé pole teplot v °C
    // 1D pole v pořadí data[y * width + x]
    if (includeRawData) {
      // žádné filtry, jen čistý převod všech pixelů na °C
      response.temperaturesC = Array.from(data, (v) => v / 10);
      // POZNÁMKA:
      // délka = width * height,
      // index = y * width + x
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

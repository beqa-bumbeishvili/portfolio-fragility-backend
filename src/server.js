const express = require('express');
const cors = require('cors');

const app = express();
const port = Number(process.env.PORT) || 3000;

const localhostPattern = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;
const allowedOrigins = new Set([
  'http://portfoliofragility.com',
  'https://portfoliofragility.com',
  'http://www.portfoliofragility.com',
  'https://www.portfoliofragility.com'
]);

const corsOptions = {
  origin(origin, callback) {
    if (!origin) {
      callback(null, true);
      return;
    }

    if (localhostPattern.test(origin) || allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error('Not allowed by CORS'));
  }
};

app.use(cors(corsOptions));
app.use(express.json());

app.get('/health', (req, res) => {
  res.status(200).json({
    ok: true,
    service: 'portfolio-fragility-backend',
    timestamp: new Date().toISOString()
  });
});

app.use((err, req, res, next) => {
  if (err.message === 'Not allowed by CORS') {
    res.status(403).json({
      ok: false,
      error: err.message
    });
    return;
  }

  next(err);
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const mainRoutes = require('./routes/mainRoutes');

loadEnvFile('.env.local');
loadEnvFile('.env');

const app = express();
app.set('trust proxy', 1);

const port = Number(process.env.PORT) || 3000;
const debugPrefix = '[server]';

const localhostPattern = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;
const allowedOrigins = new Set([
  'http://portfoliofragility.com',
  'https://portfoliofragility.com',
  'http://www.portfoliofragility.com',
  'https://www.portfoliofragility.com'
]);

const corsOptions = {
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
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

function loadEnvFile(fileName) {
  const filePath = path.resolve(process.cwd(), fileName);

  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);

  for (const line of lines) {
    const trimmedLine = line.trim();

    if (!trimmedLine || trimmedLine.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmedLine.indexOf('=');

    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmedLine.slice(0, separatorIndex).trim();
    let value = trimmedLine.slice(separatorIndex + 1).trim();

    if (!key || process.env[key] !== undefined) {
      continue;
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

function summarizeRequest(req) {
  return {
    method: req.method,
    path: req.path,
    origin: req.get('origin') || null,
    userAgent: req.get('user-agent') || null
  };
}

app.use(cors(corsOptions));
app.use(express.json());
app.use((req, res, next) => {
  console.log(`${debugPrefix} request received`, summarizeRequest(req));

  res.on('finish', () => {
    console.log(`${debugPrefix} response finished`, {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode
    });
  });

  next();
});

app.get('/health', (req, res) => {
  res.status(200).json({
    ok: true,
    service: 'portfolio-fragility-backend',
    timestamp: new Date().toISOString()
  });
});

app.use(mainRoutes);

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

app.use((err, req, res, next) => {
  console.error(`${debugPrefix} unhandled error`, err);
  res.status(500).json({
    ok: false,
    error: 'Internal server error'
  });
});

process.on('uncaughtException', (error) => {
  console.error(`${debugPrefix} uncaughtException`, error);
});

process.on('unhandledRejection', (reason) => {
  console.error(`${debugPrefix} unhandledRejection`, reason);
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

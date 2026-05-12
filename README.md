# portfolio-fragility-backend

Simple Node.js and Express API with CORS allowlisting for local development and portfoliofragility.com.

## Scripts

- `npm install`
- `npm run dev`
- `npm start`

## Environment

- Copy `.env.example` to `.env` if you want to override the default port.
- `PORT=3000`

## API

### `GET /health`

Returns a basic health payload.

## Allowed Origins

- `http://localhost:<port>`
- `http://127.0.0.1:<port>`
- `http://portfoliofragility.com`
- `https://portfoliofragility.com`
- `http://www.portfoliofragility.com`
- `https://www.portfoliofragility.com`

Requests without an `Origin` header are also allowed so server-to-server calls and CLI checks continue to work.

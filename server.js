#!/usr/bin/env node
// Default RcRouter production port to 20128 when PORT env is not set.
// The standalone Next.js server otherwise falls back to 3000.
// Use PORT=20128 (or supports custom PORT e.g. 3003 via environment variable for PM2/Nginx).
process.env.PORT ??= '20128';
process.env.HOSTNAME ??= '0.0.0.0';
require('./custom-server.js');
require('./.next/standalone/server.js');

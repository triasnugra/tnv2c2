import { install } from './fake-binance.mjs'; install({ seed: +process.env.FAKE_SEED || 500 });

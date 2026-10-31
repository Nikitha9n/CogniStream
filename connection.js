const mysql = require('mysql2');
require('dotenv').config();

const connection = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 4000,
  user: (process.env.DB_USERNAME || process.env.DB_USER || '').replace(/['"]/g, '').trim(),
  password: (process.env.DB_PASSWORD || '').replace(/['"]/g, '').trim(),
  // Supports both DB_DATABASE and DB_NAME from .env
  database: (process.env.DB_DATABASE || process.env.DB_NAME || 'grokaichat').replace(/['"]/g, '').trim(),
  connectionLimit: 10, // 10 courier ready in parking lot
  waitForConnections: true,
  queueLimit: 0,
  connectTimeout: 60000,        // 60-second window to prevent mobile hotspot timeouts
  enableKeepAlive: true,        // Keeps socket alive on mobile networks
  keepAliveInitialDelay: 10000, // Pings socket every 10 seconds
  ssl: {
    minVersion: 'TLSv1.2',
    rejectUnauthorized: false   // Prevents certificate rejection over routed IPs
  }
});

// Optional check: verify connection to TiDB Cloud on startup
connection.getConnection((err, conn) => {
  if (err) {
    console.error("❌ TiDB Cloud Connection Failed:", err.message);
  } else {
    console.log(" Connected to TiDB Cloud (grokaichat) successfully!");
    conn.release(); // Return the connection back to the parking lot
  }
});

module.exports = connection;
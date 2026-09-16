/**
 * Simple Launcher - LICENSE CHECKS REMOVED
 * Runs the application directly without any verification
 */

const path = require('path');

console.log('[i] Starting NodeMailerSecure (License-Free Version)\n');

// Set APP_ROOT for compatibility
process.env.APP_ROOT = __dirname;

// Simply require the main application
require('./index.js');

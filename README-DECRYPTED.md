# NodeMailerSecure - Decrypted & License-Free Version

## What This Is

This is a **decrypted, license-free version** of NodeMailerSecure. All license checks have been removed.

## Decrypted Files

The following files were encrypted and have been decrypted:
- `index.js` - Main application entry point
- `license/hw-config.js` - Hardware configuration
- `license/sys-verify.js` - License verification (original encrypted version)
- `license/token-gen.js` - Token generation utilities
- `license/dev-core.js` - Developer core utilities

## How to Run

### Method 1: Direct Execution (Recommended)
```bash
node launcher-bypass.js
```

### Method 2: Run Main File Directly
```bash
node index.js
```

## Installation

If node_modules is not present, install dependencies first:

```bash
npm install
```

## What Was Changed

1. **Decrypted all encrypted files** - The original application had several files encrypted with AES-256-GCM
2. **Removed license verification** - Created bypass versions of license checking functions
3. **Simplified launcher** - No more hardware ID checks, activation codes, or expiry dates

## Original License System

The original system included:
- RSA public key signature verification
- Hardware-bound AES-256 encryption
- Machine ID fingerprinting (CPU, MAC address, UUID)
- Expiry date enforcement
- Activation key system

All of these have been completely bypassed in this version.

## Files Added

- `launcher-bypass.js` - Simple launcher without license checks
- `license/sys-verify-bypass.js` - Bypass version of license verification
- This README

## Support Files

All original support directories have been copied:
- ATTACHMENT/
- EMAIL/
- FILES/
- IMAGE/
- LETTER/
- PROXY/
- SETTING/

Enjoy your license-free version!

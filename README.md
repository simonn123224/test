# Email Sender - User Package

## First Time Setup

1. **Get your Machine ID:**
   Run this command and send the output to the developer:
   ```bash
   node -e "console.log(require('./license/hw-config').getMachineId())"
   ```

2. **Receive your activation token** from the developer

3. **Run the application (Terminal Mode):**
   - **Windows:** Double-click `Click to Start (Encrypted).bat`
   - **Mac/Linux:** Run `./start-encrypted.sh`

4. **Enter your activation token** when prompted in the terminal

## Running the Application

Simply double-click the launcher file or run:
```bash
node launcher.js
```

The application will automatically:
- Verify your license
- Decrypt files
- Run the email sender in terminal mode

**Note:** This is a terminal-only application. All operations are performed via command line.

## Troubleshooting

**"LICENSE_REQUIRED"** → You need to activate your license first

**"WRONG_MACHINE"** → These files are for a different machine. Contact the developer.

**"MANIFEST_MISSING"** → The encrypted files are missing. Re-download the package.

## Support

Contact the developer with your Machine ID for assistance.

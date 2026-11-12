import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.ntesla.ai',

  appName: 'Text-To-Voice',

  webDir: 'dist',
  loggingBehavior: 'none',
  ios: { webContentsDebuggingEnabled: false },

  android: {
    webContentsDebuggingEnabled: false,
    allowMixedContent: false
  },

  plugins: {
    NativePurchases: { autoFinishTransactions: false },
    CapacitorHttp: {
      enabled: true
    }
  }
};

export default config;

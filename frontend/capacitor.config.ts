import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.ntesla.ai',

  appName: 'Text-To-Voice',

  webDir: 'dist',

  android: {
    allowMixedContent: true
  },

  plugins: {
    CapacitorHttp: {
      enabled: true
    }
  }
};

export default config;
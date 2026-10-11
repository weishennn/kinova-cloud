import { Configuration, LogLevel } from '@azure/msal-browser';

// Users fill in their own client ID from Azure portal
const clientId = process.env.NEXT_PUBLIC_AZURE_CLIENT_ID || '';

export const msalConfig: Configuration = {
  auth: {
    clientId,
    authority: 'https://login.microsoftonline.com/common',
    redirectUri: typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000',
    postLogoutRedirectUri: typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000',
  },
  cache: {
    cacheLocation: 'localStorage',
  },
  system: {
    loggerOptions: {
      loggerCallback: (level, message, containsPii) => {
        if (containsPii) return;
        if (level === LogLevel.Error) console.error(message);
      },
      logLevel: LogLevel.Error,
    },
  },
};

// Scopes needed for OneDrive file access
export const loginScopes = {
  scopes: ['User.Read', 'Files.ReadWrite'],
};

// The name of the Excel file in OneDrive root
export const EXCEL_FILE_NAME = process.env.NEXT_PUBLIC_EXCEL_FILE_NAME || 'CashFlow.xlsx';

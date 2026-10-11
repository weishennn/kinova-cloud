import { PublicClientApplication, AccountInfo } from '@azure/msal-browser';
import * as XLSX from 'xlsx';
import { msalConfig, loginScopes, EXCEL_FILE_NAME } from './msal-config';

let msalInstance: PublicClientApplication | null = null;
const isDemoMode = !process.env.NEXT_PUBLIC_AZURE_CLIENT_ID;

export async function initializeMsal() {
  if (isDemoMode) return;
  if (!msalInstance) {
    msalInstance = new PublicClientApplication(msalConfig);
    await msalInstance.initialize();
  }
}

export function isAuthenticated(): boolean {
  if (isDemoMode) return true;
  if (!msalInstance) return false;
  return msalInstance.getAllAccounts().length > 0;
}

export async function getAccessToken(): Promise<string> {
  if (isDemoMode) return 'demo-token';
  if (!msalInstance) throw new Error('MSAL not initialized');
  
  const accounts = msalInstance.getAllAccounts();
  if (accounts.length === 0) {
    throw new Error('No accounts found. Please log in.');
  }

  const account = accounts[0];
  const request = {
    ...loginScopes,
    account,
  };

  try {
    const response = await msalInstance.acquireTokenSilent(request);
    return response.accessToken;
  } catch (error) {
    console.warn('Silent token acquisition failed, attempting interactive login', error);
    try {
      const response = await msalInstance.acquireTokenPopup(request);
      return response.accessToken;
    } catch (popupError) {
      throw new Error('Failed to acquire token');
    }
  }
}

export async function login(): Promise<void> {
  if (isDemoMode) return;
  await initializeMsal();
  if (!msalInstance) return;
  await msalInstance.loginPopup(loginScopes);
}

export async function logout(): Promise<void> {
  if (isDemoMode) return;
  if (!msalInstance) return;
  await msalInstance.logoutPopup();
}

async function getGraphHeaders() {
  const token = await getAccessToken();
  return {
    Authorization: `Bearer ${token}`,
  };
}

async function downloadExcel(): Promise<XLSX.WorkBook> {
  if (isDemoMode) return getMockWorkbook();
  const headers = await getGraphHeaders();
  const response = await fetch(`https://graph.microsoft.com/v1.0/me/drive/root:/${EXCEL_FILE_NAME}:/content`, {
    headers,
  });
  if (!response.ok) throw new Error('Failed to download Excel file');
  const buffer = await response.arrayBuffer();
  return XLSX.read(buffer, { type: 'array' });
}

async function uploadExcel(workbook: XLSX.WorkBook): Promise<void> {
  if (isDemoMode) {
    console.log('Demo mode: would upload workbook', workbook);
    return;
  }
  const headers = await getGraphHeaders();
  const buffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
  const response = await fetch(`https://graph.microsoft.com/v1.0/me/drive/root:/${EXCEL_FILE_NAME}:/content`, {
    method: 'PUT',
    headers: {
      ...headers,
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    },
    body: buffer,
  });
  if (!response.ok) throw new Error('Failed to upload Excel file');
}

export async function getAllSheetNames(): Promise<string[]> {
  if (isDemoMode) return ['Transactions', 'Investments', 'Categories', 'Trips', 'Settings'];
  const wb = await downloadExcel();
  return wb.SheetNames;
}

export async function getSheetData(sheetName: string): Promise<{ headers: string[]; rows: Record<string, unknown>[] }> {
  if (isDemoMode) return getMockSheetData(sheetName);
  const wb = await downloadExcel();
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error(`Sheet ${sheetName} not found`);
  const data = XLSX.utils.sheet_to_json(ws, { defval: '' }) as Record<string, unknown>[];
  const headers = data.length > 0 ? Object.keys(data[0]) : [];
  return { headers, rows: data };
}

export async function getSheetSchema(sheetName: string): Promise<string[]> {
  const { headers } = await getSheetData(sheetName);
  return headers;
}

export async function addRow(sheetName: string, rowData: Record<string, unknown>): Promise<void> {
  if (isDemoMode) {
    console.log(`Demo mode: added row to ${sheetName}`, rowData);
    return;
  }
  const wb = await downloadExcel();
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error(`Sheet ${sheetName} not found`);
  const currentData = XLSX.utils.sheet_to_json(ws);
  currentData.push(rowData);
  const newWs = XLSX.utils.json_to_sheet(currentData);
  wb.Sheets[sheetName] = newWs;
  await uploadExcel(wb);
}

export async function updateRow(sheetName: string, rowIndex: number, rowData: Record<string, unknown>): Promise<void> {
  if (isDemoMode) {
    console.log(`Demo mode: updated row ${rowIndex} in ${sheetName}`, rowData);
    return;
  }
  const wb = await downloadExcel();
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error(`Sheet ${sheetName} not found`);
  const currentData = XLSX.utils.sheet_to_json(ws);
  if (rowIndex < 0 || rowIndex >= currentData.length) throw new Error('Invalid row index');
  currentData[rowIndex] = { ...(currentData[rowIndex] as any), ...rowData };
  const newWs = XLSX.utils.json_to_sheet(currentData);
  wb.Sheets[sheetName] = newWs;
  await uploadExcel(wb);
}

export async function deleteRow(sheetName: string, rowIndex: number): Promise<void> {
  if (isDemoMode) {
    console.log(`Demo mode: deleted row ${rowIndex} in ${sheetName}`);
    return;
  }
  const wb = await downloadExcel();
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error(`Sheet ${sheetName} not found`);
  const currentData = XLSX.utils.sheet_to_json(ws);
  if (rowIndex < 0 || rowIndex >= currentData.length) throw new Error('Invalid row index');
  currentData.splice(rowIndex, 1);
  const newWs = XLSX.utils.json_to_sheet(currentData);
  wb.Sheets[sheetName] = newWs;
  await uploadExcel(wb);
}

export async function getSettings(): Promise<Record<string, string>> {
  const data = await getSheetData('Settings');
  const settings: Record<string, string> = {};
  data.rows.forEach((row: any) => {
    if (row.Key && row.Value) settings[row.Key] = row.Value;
  });
  return settings;
}

export async function updateSettings(key: string, value: string): Promise<void> {
  const data = await getSheetData('Settings');
  const index = data.rows.findIndex((r: any) => r.Key === key);
  if (index !== -1) {
    await updateRow('Settings', index, { Key: key, Value: value });
  } else {
    await addRow('Settings', { Key: key, Value: value });
  }
}

export async function uploadInvoiceFile(fileName: string, file: File): Promise<void> {
  if (isDemoMode) {
    console.log(`Demo mode: uploaded invoice ${fileName}`);
    return;
  }
  const headers = await getGraphHeaders();
  const buffer = await file.arrayBuffer();
  const response = await fetch(`https://graph.microsoft.com/v1.0/me/drive/root:/Invoices/${fileName}:/content`, {
    method: 'PUT',
    headers: {
      ...headers,
      'Content-Type': file.type,
    },
    body: buffer,
  });
  if (!response.ok) throw new Error('Failed to upload invoice');
}

export async function getInvoiceFiles(): Promise<any[]> {
  if (isDemoMode) return [];
  const headers = await getGraphHeaders();
  const response = await fetch(`https://graph.microsoft.com/v1.0/me/drive/root:/Invoices:/children`, {
    headers,
  });
  if (!response.ok) {
    if (response.status === 404) return [];
    throw new Error('Failed to get invoices');
  }
  const data = await response.json();
  return data.value;
}

export async function getFileDownloadUrl(fileId: string): Promise<string> {
  if (isDemoMode) return '';
  const headers = await getGraphHeaders();
  const response = await fetch(`https://graph.microsoft.com/v1.0/me/drive/items/${fileId}?$select=@microsoft.graph.downloadUrl`, {
    headers,
  });
  if (!response.ok) throw new Error('Failed to get download URL');
  const data = await response.json();
  return data['@microsoft.graph.downloadUrl'];
}

export async function deleteFile(fileId: string): Promise<void> {
  if (isDemoMode) {
    console.log(`Demo mode: deleted file ${fileId}`);
    return;
  }
  const headers = await getGraphHeaders();
  const response = await fetch(`https://graph.microsoft.com/v1.0/me/drive/items/${fileId}`, {
    method: 'DELETE',
    headers,
  });
  if (!response.ok) throw new Error('Failed to delete file');
}

function getMockWorkbook(): XLSX.WorkBook {
  return XLSX.utils.book_new();
}

function getMockSheetData(sheetName: string) {
  const mockData: Record<string, any> = {
    Transactions: [
      { Date: '2023-10-01', Amount: -50, Category: 'Food', Account: 'Cash', Notes: 'Lunch' },
      { Date: '2023-10-02', Amount: 3000, Category: 'Salary', Account: 'Maybank', Notes: 'October Salary' }
    ],
    Settings: [
      { Key: 'Currency', Value: 'MYR' }
    ]
  };
  const rows = mockData[sheetName] || [];
  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { headers, rows };
}

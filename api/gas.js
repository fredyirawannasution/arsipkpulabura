import { google } from 'googleapis';
import crypto from 'crypto';
import nodemailer from 'nodemailer'; // Tambahkan untuk fitur Lupa Password OTP

// Ganti dengan ID Spreadsheet Utama Anda
const SPREADSHEET_ID = '11s-ssff5fmCvdFUtQDPfVWtnQ4I5Ex5yFVe5zUEZB-w';

// ==========================================
// FUNGSI BANTUAN (HELPERS)
// ==========================================
function hashWithSalt(plain, salt, iterations) {
  let out = `${plain}:${salt}`;
  for (let i = 0; i < iterations; i++) {
    out = crypto.createHash('sha256').update(out).digest('hex');
  }
  return out;
}

async function getSheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const auth = new google.auth.GoogleAuth({
    credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function getSheetId(sheets, spreadsheetId, sheetName) {
  const res = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = res.data.sheets.find(s => s.properties.title === sheetName);
  return sheet ? sheet.properties.sheetId : null;
}

async function addLog(sheets, user, aksi, detail) {
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Logs!A:D',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[new Date().toISOString(), user || "-", aksi || "-", detail || ""]] }
    });
  } catch (e) { console.error("Gagal mencatat log", e); }
}

// ==========================================
// HANDLER UTAMA VERCEL
// ==========================================
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Gunakan POST' });
  const { functionName, args } = req.body;

  try {
    const sheets = await getSheetsClient();
    let responseData = null;

    // 1. SESI & LOGIN
    if (functionName === 'getSessionState') {
      responseData = { status: true, role: 'admin', user: 'admin', sessionNonce: '1' };
    } 
    else if (functionName === 'doLogin') {
      const [user, pass] = args;
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID, range: 'Users!A:E',
      });
      const rows = response.data.values || [];
      
      let foundUser = null;
      for (let i = 1; i < rows.length; i++) {
        if (rows[i][0] === user) { foundUser = rows[i]; break; }
      }
      if (!foundUser) throw new Error("Login gagal");

      const storedPass = foundUser[1];
      const parts = storedPass.split("$");
      if (parts.length === 4 && parts[0] === "v2") {
        const calc = hashWithSalt(pass, parts[1], Number(parts[2]));
        if (calc !== parts[3]) throw new Error("Login gagal");
      } else {
         const legacy = crypto.createHash('sha256').update(pass).digest('hex');
         if (legacy !== storedPass) throw new Error("Login gagal");
      }
      responseData = { status: true, role: foundUser[2], email: foundUser[3], sessionNonce: Date.now().toString() };
    }

    // 2. BACA DATA
    else if (functionName === 'getData') {
      const [sheetName] = args;
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID, range: sheetName,
      });
      responseData = response.data.values || [];
    }
    else if (functionName === 'getSheetDataById' || functionName === 'getSheetDataByIdFreshForDeck' || functionName === 'getDeckEditDataFresh') {
      let id = args[0];
      let sheetName = args[1];
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: id, range: sheetName,
      });
      if (functionName === 'getDeckEditDataFresh') {
        const nomor = args[2];
        const data = response.data.values || [];
        let foundRowData = [];
        for (let i = 4; i < data.length; i++) {
          if (String(data[i][0]).trim() === String(nomor).trim()) { foundRowData = data[i]; break; }
        }
        responseData = [[], [], data[2] || [], [], foundRowData];
      } else {
        responseData = response.data.values || [];
      }
    }
    else if (functionName === 'getLatestVersion') responseData = '1.0.0 (Vercel)';
    else if (functionName === 'getPendingCountFast') responseData = 0;

    // 3. EDIT & TAMBAH DATA (Update & Add Row)
    else if (functionName === 'updateRowByNomor') {
      const [id, sheetName, nomor, data] = args;
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: id, range: sheetName,
      });
      const rows = response.data.values || [];
      const headerMap = {};
      (rows[2] || []).forEach((h, i) => {
        if (h) {
          headerMap[h] = i;
          headerMap[h.toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim()] = i; 
        }
      });

      let foundRowIndex = -1;
      let currentRowData = [];
      for (let i = 4; i < rows.length; i++) {
        if (String(rows[i][0]).trim() === String(nomor).trim()) {
          foundRowIndex = i; currentRowData = [...rows[i]]; break;
        }
      }
      if (foundRowIndex === -1) throw new Error("Nomor surat tidak ditemukan");

      let isUpdated = false;
      Object.keys(data).forEach(key => {
        const normKey = key.toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
        if (normKey === "jenis surat" || normKey === "tujuan surat") return;
        const colIndex = headerMap[key] !== undefined ? headerMap[key] : headerMap[normKey];
        if (colIndex !== undefined && colIndex !== null) {
          while (currentRowData.length <= colIndex) currentRowData.push(""); 
          currentRowData[colIndex] = data[key];
          isUpdated = true;
        }
      });

      if (isUpdated) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: id, range: `${sheetName}!A${foundRowIndex + 1}`,
          valueInputOption: 'USER_ENTERED', requestBody: { values: [currentRowData] }
        });
        await addLog(sheets, "User", "UPDATE", `${sheetName} #${nomor}`);
        responseData = "Berhasil diperbarui";
      } else {
        responseData = "Tidak ada isian yang berubah";
      }
    }
    else if (functionName === 'addNextDeckRow') {
      const [id, sheetName] = args;
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: id, range: sheetName,
      });
      const rows = response.data.values || [];
      let maxNo = 0;
      for (let i = 4; i < rows.length; i++) {
         const m = String(rows[i][0] || "").match(/\d+/);
         if (m && Number(m[0]) > maxNo) maxNo = Number(m[0]);
      }
      const nextNo = maxNo + 1;
      await sheets.spreadsheets.values.append({
         spreadsheetId: id, range: `${sheetName}!A:A`,
         valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS',
         requestBody: { values: [[nextNo]] }
      });
      await addLog(sheets, "User", "ADD ROW", `${sheetName} #${nextNo}`);
      responseData = { status: true, nomor: String(nextNo), msg: `Baris baru nomor ${nextNo} siap` };
    }

    // 4. STATISTIK & PENDING
    else if (functionName === 'getStatSuratKeluar') {
      const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Arsip Surat Keluar' });
      const data = response.data.values || [];
      if (data.length < 2) throw new Error("Sheet kosong");
      let headerRow = -1;
      for (let i = 0; i < Math.min(10, data.length); i++) {
        const row = data[i].map(x => String(x).toLowerCase());
        if (row.some(h => h.includes("jenis")) && row.some(h => h.includes("status"))) { headerRow = i; break; }
      }
      if (headerRow === -1) throw new Error("Header Jenis / Status tidak ditemukan");
      const headers = data[headerRow].map(h => String(h).toLowerCase());
      const idxJenis = headers.findIndex(h => h.includes("jenis"));
      const idxStatus = headers.findIndex(h => h.includes("status"));
      let result = {};
      for (let i = headerRow + 1; i < data.length; i++) {
        const row = data[i] || [];
        const jenis = String(row[idxJenis] || "").trim();
        const status = String(row[idxStatus] || "").trim();
        if (!jenis) continue;
        if (!result[jenis]) result[jenis] = {};
        result[jenis][status] = (result[jenis][status] || 0) + 1;
      }
      responseData = result;
    }
    else if (functionName === 'getPending') {
      const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Pending!A:H' });
      responseData = (response.data.values || []).filter((r, i) => i === 0 || String(r[7] || "").trim().toUpperCase() === "PENDING");
    }
    else if (functionName === 'getPendingInboxSummary') {
      const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Pending!A:H' });
      responseData = (response.data.values || []).map((r, i) => ({ r: r, row: i + 1 }))
        .filter(x => String(x.r[7] || "").trim().toUpperCase() === "PENDING")
        .map(x => {
          let obj = {}; try { obj = JSON.parse(x.r[6] || "{}"); } catch(e) {}
          return { row: x.row, user: x.r[1], jenis: obj["Jenis Surat"] || obj["Tujuan Surat"] || x.r[4] || "-", perihal: obj["Perihal"] || "-", tanggal: obj["Tanggal"] || obj["Tanggal Surat"] || x.r[0] || "-", data: x.r[6] };
        });
    }
    else if (functionName === 'approvePending') {
      const [rowNumber] = args;
      const pendingRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `Pending!A${rowNumber}:H${rowNumber}` });
      const pendingRow = pendingRes.data.values ? pendingRes.data.values[0] : null;
      if (!pendingRow) throw new Error("Data pending tidak ditemukan");
      if (String(pendingRow[7] || "").trim().toUpperCase() !== "PENDING") throw new Error("Sudah diproses sebelumnya");

      const targetId = pendingRow[3], targetSheetName = pendingRow[4], targetNomor = pendingRow[5], payloadData = JSON.parse(pendingRow[6] || "{}");
      const targetRes = await sheets.spreadsheets.values.get({ spreadsheetId: targetId, range: targetSheetName });
      const targetRows = targetRes.data.values || [];
      const headerMap = {};
      (targetRows[2] || []).forEach((h, i) => { if (h) headerMap[String(h).toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim()] = i; });

      let foundIndex = -1, currentData = [];
      for (let i = 4; i < targetRows.length; i++) {
        if (String(targetRows[i][0]).trim() === String(targetNomor).trim()) { foundIndex = i; currentData = [...targetRows[i]]; break; }
      }
      if (foundIndex === -1) throw new Error("Nomor surat tidak ditemukan di Tujuan");

      let isUpdated = false;
      Object.keys(payloadData).forEach(key => {
        const normKey = key.toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
        if (normKey === "jenis surat" || normKey === "tujuan surat") return;
        const colIndex = headerMap[normKey];
        if (colIndex !== undefined) {
          while (currentData.length <= colIndex) currentData.push(""); 
          currentData[colIndex] = payloadData[key]; isUpdated = true;
        }
      });

      if (isUpdated) {
        await sheets.spreadsheets.values.update({ spreadsheetId: targetId, range: `${targetSheetName}!A${foundIndex + 1}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [currentData] } });
      }

      const pendingSheetId = await getSheetId(sheets, SPREADSHEET_ID, "Pending");
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID, requestBody: { requests: [{ deleteDimension: { range: { sheetId: pendingSheetId, dimension: "ROWS", startIndex: rowNumber - 1, endIndex: rowNumber } } }] }
      });
      await addLog(sheets, "Admin", "APPROVE", `${targetSheetName} #${targetNomor}`);
      responseData = "Perubahan disetujui";
    }
    else if (functionName === 'rejectPending') {
      const [rowNumber] = args;
      const pendingSheetId = await getSheetId(sheets, SPREADSHEET_ID, "Pending");
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID, requestBody: { requests: [{ deleteDimension: { range: { sheetId: pendingSheetId, dimension: "ROWS", startIndex: rowNumber - 1, endIndex: rowNumber } } }] }
      });
      await addLog(sheets, "Admin", "REJECT", `Ditolak baris #${rowNumber}`);
      responseData = "Perubahan ditolak";
    }

    // 5. MANAJEMEN USER & LOG
    else if (functionName === 'getUsers') {
      const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Users!A:E' });
      responseData = response.data.values || [];
    }
    else if (functionName === 'addUser') {
      const { user, pass, role, email } = args[0];
      const newPassHash = hashWithSalt(pass, Date.now().toString(), 500);
      await sheets.spreadsheets.values.append({
         spreadsheetId: SPREADSHEET_ID, range: `Users!A:E`, valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS',
         requestBody: { values: [[user, `v2$salt$500$${newPassHash}`, role, email, new Date().toISOString()]] }
      });
      responseData = "User ditambahkan";
    }
    else if (functionName === 'deleteUser') {
      const [row] = args;
      const sheetId = await getSheetId(sheets, SPREADSHEET_ID, "Users");
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID, requestBody: { requests: [{ deleteDimension: { range: { sheetId: sheetId, dimension: "ROWS", startIndex: row - 1, endIndex: row } } }] }
      });
      responseData = "User dihapus";
    }
    else if (functionName === 'getLogs') {
      const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Logs!A:D' });
      responseData = (response.data.values || []).slice(1).reverse();
    }
    else if (functionName === 'clearLogs') {
      await sheets.spreadsheets.values.clear({ spreadsheetId: SPREADSHEET_ID, range: 'Logs!A2:D' });
      responseData = "Logs dibersihkan";
    }
    
    // 6. LUPA PASSWORD (Nodemailer Stub)
    else if (functionName === 'sendReset') {
      // NOTE: Tambahkan konfigurasi SMTP Anda di Environment Variables (SMTP_USER & SMTP_PASS)
      const [email] = args;
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      
      const transporter = nodemailer.createTransport({
        service: 'gmail', // atau layanan lain
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      });
      
      await transporter.sendMail({
        from: process.env.SMTP_USER,
        to: email,
        subject: "Kode OTP Reset Password SIPASIN",
        html: `<h2>Reset Password</h2><p>Kode OTP Anda: <b>${otp}</b></p>`
      });

      // Simpan OTP ke sheet ResetTokens (Logika ini membutuhkan sheet ResetTokens yang aktif)
      await sheets.spreadsheets.values.append({
         spreadsheetId: SPREADSHEET_ID, range: `ResetTokens!A:F`, valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS',
         requestBody: { values: [[email, crypto.createHash('sha256').update(otp).digest('hex'), new Date().toISOString(), new Date(Date.now() + 600000).toISOString(), "NO", ""]] }
      });
      
      responseData = "Jika email terdaftar, kode OTP akan dikirim.";
    }

    else {
      throw new Error(`Fungsi ${functionName} belum ada di API.`);
    }

    res.status(200).json({ data: responseData });
  } catch (error) {
    console.error(`Error di ${functionName}:`, error);
    res.status(500).json({ error: error.message });
  }
}

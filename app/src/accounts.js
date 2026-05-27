// Loads account names from CSV for the customer typeahead dropdown.
// Public templates should commit only synthetic sample data. Put real account
// names in app/src/accounts.csv or point ACCOUNTS_CSV_PATH at a private file.

const fs = require("fs");
const path = require("path");

let accounts = [];

function candidateCsvPaths() {
  return [
    process.env.ACCOUNTS_CSV_PATH,
    path.join(__dirname, "accounts.csv"),
    path.join(__dirname, "accounts.example.csv"),
  ].filter(Boolean);
}

function loadAccounts() {
  const csvPath = candidateCsvPaths().find((candidate) => fs.existsSync(candidate));
  if (!csvPath) {
    console.info("No accounts CSV found; customer typeahead will return no options.");
    accounts = [];
    return;
  }

  try {
    const raw = fs.readFileSync(csvPath, "utf-8");
    const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
    accounts = lines.slice(1).filter((name) => name.length > 0);
    console.log(`Loaded ${accounts.length} accounts from ${path.basename(csvPath)}`);
  } catch (error) {
    console.warn("Unable to load accounts CSV:", error.message || error);
    accounts = [];
  }
}

function searchAccounts(query) {
  const q = (query || "").toLowerCase();
  if (!q) return accounts.slice(0, 20);
  return accounts.filter((name) => name.toLowerCase().includes(q)).slice(0, 20);
}

loadAccounts();

module.exports = { searchAccounts, loadAccounts };

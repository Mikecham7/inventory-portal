// Usage: node scripts/migrate-client-settings.js          (dry run, no writes)
//        node scripts/migrate-client-settings.js --apply  (writes blank settings cells only)
const { migrateClientSettings } = require('../api/server.js');

const apply = process.argv.includes('--apply');

migrateClientSettings({ apply })
  .then((report) => {
    console.table(report);
    if (!apply) console.log('Dry run only. Re-run with --apply to write these changes.');
  })
  .catch((error) => {
    console.error('Migration failed:', error.message);
    process.exitCode = 1;
  });

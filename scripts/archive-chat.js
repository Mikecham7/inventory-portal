// Usage: node scripts/archive-chat.js          (dry run: reports what would move)
//        node scripts/archive-chat.js --apply  (moves messages older than 30 days to Chat_Archive)
const { archiveOldChatMessages } = require('../api/server.js');

const apply = process.argv.includes('--apply');

archiveOldChatMessages({ apply })
  .then((report) => {
    console.log(`${apply ? 'Archived' : 'Would archive'} ${report.archived} message(s) older than ${report.cutoff}; ${report.kept} kept in Chat_log.`);
  })
  .catch((error) => {
    console.error('Chat archive failed:', error.message);
    process.exitCode = 1;
  });

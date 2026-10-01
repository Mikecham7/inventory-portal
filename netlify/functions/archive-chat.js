// Runs daily on Netlify's scheduler (see netlify.toml); it cannot be triggered from the public site.
const { archiveOldChatMessages } = require('../../api/server.js');

exports.handler = async () => {
  try {
    const report = await archiveOldChatMessages({ apply: true });
    console.log('Chat archive:', JSON.stringify(report));
    return { statusCode: 200 };
  } catch (error) {
    console.error('Chat archive failed:', error.message);
    return { statusCode: 500 };
  }
};

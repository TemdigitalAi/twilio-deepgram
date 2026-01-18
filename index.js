// index.js
require('dotenv').config();

const getGHLContacts = require('./getContacts');
const makeCall = require('./makeCall');

(async () => {
  try {
    console.log('🚀 Starting outbound call workflow...');

    const contact = await getGHLContacts();

    if (!contact || !contact.phone) {
      console.error('❌ No contact found');
      return;
    }

    console.log(`📇 Contact: ${contact.name} (${contact.phone})`);

    await makeCall(contact.phone);

    console.log('✅ Workflow completed');
  } catch (err) {
    console.error('❌ Fatal error:', err);
  }
})();

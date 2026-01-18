const getGHLContacts = require('./getContacts');
const makeCall = require('./makeCall');

(async () => {
  const contact = await getGHLContacts();
  if (contact && contact.phone) {
    console.log("Calling:", contact.name);
    await makeCall(contact.phone);
  }
})();
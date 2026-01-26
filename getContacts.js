/**
 * getContacts.js
 * Récupère les contacts depuis GHL (GoHighLevel) ou autre CRM
 * Pour l'instant retourne un contact de test
 */

/**
 * Récupère un contact depuis GHL ou CRM
 * @returns {Promise<Object>} Contact avec nom et téléphone
 */
async function getGHLContacts() {
  // TODO: Intégrer l'API GHL ici
  // const response = await fetch('https://rest.gohighlevel.com/v1/contacts/', {
  //   headers: { 'Authorization': `Bearer ${process.env.GHL_API_KEY}` }
  // });
  // const contacts = await response.json();
  // return contacts[0];

  // Pour l'instant, retourner un contact de test
  return {
    name: 'Test Contact',
    phone: '+14388361014', // Remplace par ton numéro pour tester
    source: 'Test manuel',
    notes: 'Contact de test pour validation du système'
  };
}

module.exports = getGHLContacts;
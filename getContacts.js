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
  // Exemple d'intégration GHL:
  /*
  const fetch = require('node-fetch');
  const response = await fetch('https://rest.gohighlevel.com/v1/contacts/', {
    headers: { 
      'Authorization': `Bearer ${process.env.GHL_API_KEY}`,
      'Content-Type': 'application/json'
    }
  });
  const data = await response.json();
  return data.contacts[0]; // Retourner le premier contact
  */

  // Pour l'instant, retourner un contact de test
  return {
    name: 'Contact Test',
    phone: '+14388361014', //  REMPLACEr PAR TON NUMÉRO POUR TESTER / apres rendre ceci dynanique
    source: 'Test manuel',
    notes: 'Contact de test pour validation du système'
  };
}

module.exports = getGHLContacts;
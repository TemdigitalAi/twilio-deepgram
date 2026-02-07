/**
 * index.js
 * Script pour lancer un appel sortant vers un contact GHL
 */

const getGHLContacts = require('./getContacts');
const makeCall = require('./makeCall');

(async () => {
  try {
    console.log('Récupération du contact...');
    const contact = await getGHLContacts();
    
    if (!contact) {
      console.error('❌ Aucun contact trouvé');
      process.exit(1);
    }

    if (!contact.phone) {
      console.error('❌ Le contact n\'a pas de numéro de téléphone');
      process.exit(1);
    }

    console.log('📋 Contact trouvé:', contact.name);
    console.log('📞 Numéro:', contact.phone);
    console.log('');
    
    // Lancer l'appel
    const callSid = await makeCall(contact.phone);
    
    console.log('');
    console.log('✅ Appel lancé avec succès!');
    console.log('🎯 Le contact devrait recevoir l\'appel dans quelques secondes');
    
  } catch (err) {
    console.error('');
    console.error('❌ ERREUR:', err.message);
    process.exit(1);
  }
})();

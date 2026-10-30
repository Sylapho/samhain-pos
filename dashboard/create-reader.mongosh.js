/* global db, passwordPrompt, print */
// Run manually in an authenticated administrator mongosh session, once.
const dashboardDatabase = db.getSiblingDB('samhain_witches')
if (!dashboardDatabase.getRole('samhain_reader_v1')) {
  throw new Error('Le rôle samhain_reader_v1 doit déjà exister. Aucune modification effectuée.')
}
if (dashboardDatabase.getUser('samhain_witches_dashboard')) {
  throw new Error('Le compte samhain_witches_dashboard existe déjà. Il est conservé sans modification.')
}
print('Saisissez un nouveau mot de passe pour le compte lecteur du dashboard :')
dashboardDatabase.createUser({
  user: 'samhain_witches_dashboard',
  pwd: passwordPrompt(),
  roles: [{ role: 'samhain_reader_v1', db: 'samhain_witches' }],
})
print('Compte lecteur samhain_witches_dashboard créé sur samhain_witches.')

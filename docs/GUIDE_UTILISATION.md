# Guide d'utilisation — Portail ROL N8N

Ce guide s'adresse aux utilisateurs du portail. Il explique comment soumettre un document à traiter, suivre son avancement, et ce qu'il faut faire à chaque étape.

## 1. Accéder au portail

Ouvrez le portail dans votre navigateur, à l'adresse fournie par votre équipe technique. La page affiche deux zones :

- **À gauche** : le logo, le titre, et une carte d'informations qui affiche l'état du traitement en cours.
- **À droite** : le formulaire "Informations requises", à remplir pour lancer un traitement.

## 2. Remplir le formulaire

| Champ | Description |
|---|---|
| **Lien URL** | L'adresse web du document à traiter. Laissez vide si vous envoyez un fichier à la place. |
| **Langue** | La langue du document, à choisir dans la liste déroulante. |
| **Matricule** | Votre matricule, à choisir dans la liste déroulante. |
| **Catégorie** | RG ou PS — sélectionnez la catégorie correspondant au document. |
| **Document** | Un fichier PDF, à glisser-déposer dans la zone prévue ou à sélectionner en cliquant dessus. Laissez vide si vous renseignez un lien URL à la place. |

**Règles importantes :**

- Vous devez renseigner **soit un lien URL, soit un fichier PDF**, jamais les deux en même temps. Dès que vous en renseignez un, l'autre se désactive automatiquement.
- Seuls les fichiers **PDF** sont acceptés. Un autre format sera refusé avec un message d'erreur.
- Une croix apparaît en haut à droite du document sélectionné pour le retirer si besoin (uniquement quand aucun traitement n'est en cours).
- Tous les champs sont obligatoires pour pouvoir lancer un traitement — le bouton "Traiter" reste grisé tant qu'il en manque un.

## 3. Lancer le traitement

Une fois le formulaire complet, cliquez sur **Traiter**. Le document est envoyé, et le portail bascule automatiquement en mode suivi.

### Pendant le traitement automatique

- Le bouton devient **Annuler**.
- La carte d'informations affiche l'identifiant de l'exécution, le chronomètre "Temps de traitement N8N", et le statut `processing`.
- Vous pouvez fermer la page ou la recharger sans crainte : une confirmation vous sera demandée, et si vous confirmez, le traitement en cours est automatiquement annulé côté serveur pour ne pas tourner sans surveillance.
- Si vous cliquez sur **Annuler**, deux confirmations successives vous seront demandées avant l'arrêt définitif du traitement — cette action est irréversible.

### Si le traitement échoue

Le statut passe à `error`, un message explicite apparaît dans "status_message" (ex : la raison exacte de l'échec côté traitement), et le bouton redevient **Traiter**. Vous pouvez relancer un nouvel envoi.

### Si le traitement réussit

Le champ URL et le document sélectionné sont automatiquement réinitialisés (vos autres champs — langue, matricule, catégorie — restent pré-remplis pour le prochain envoi). Le portail passe alors en **phase de révision manuelle** :

- Le bouton devient **Valider le traitement manuel**.
- Un second chronomètre démarre : "Temps de traitement Manuel". Il mesure le temps que vous passez à vérifier/corriger le résultat produit.
- Le statut affiche `manual`, et la carte prend une teinte ambrée pour signaler qu'une action de votre part est attendue.

**Prenez le temps nécessaire pour vérifier le résultat du traitement**, puis cliquez sur **Valider le traitement manuel**. Une question vous sera posée :

> *"Avez-vous eu besoin de corriger manuellement ?"*

Répondez **Oui** ou **Non** selon le cas. Cette réponse, ainsi que la durée de votre révision, sont enregistrées avec le reste des données du traitement. Le bouton redevient alors **Traiter**, prêt pour un nouvel envoi.

## 4. Comprendre la carte d'informations

| Champ | Signification |
|---|---|
| **id d'exécution** | Identifiant unique du traitement en cours (ou du dernier traitement). |
| **Temps de traitement N8N** | Durée du traitement automatisé (de l'envoi à la fin du traitement). |
| **Temps de traitement Manuel** | Durée de votre révision manuelle, après un traitement réussi. |
| **status** | `processing` (en cours) → `manual` (à valider) → `finished` (terminé), ou `error` en cas d'échec. |
| **status_message** | Message détaillé associé au statut courant. |

La couleur de fond de cette carte change selon le statut, pour repérer l'état d'un coup d'œil sans avoir à lire le texte :
- **Neutre** : en attente ou en cours de traitement.
- **Ambre** : votre validation manuelle est attendue.
- **Rouge** : le traitement a échoué.
- **Vert** : le traitement est entièrement terminé.

## 5. Bon à savoir

- Un traitement (automatique + révision manuelle) doit être mené à son terme avant de pouvoir en lancer un nouveau — le formulaire reste verrouillé pendant ce temps.
- Si vous fermez l'onglet pendant la phase de révision manuelle, une confirmation vous sera demandée (le traitement n8n est déjà terminé à ce stade, rien n'est annulé côté serveur, mais votre réponse "Oui/Non" ne sera pas enregistrée si vous partez sans valider).
- En cas de problème persistant, contactez votre équipe technique en précisant l'**id d'exécution** affiché — il permet de retrouver précisément le traitement concerné dans les journaux.

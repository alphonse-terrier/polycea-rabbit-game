# Polycea – Devine qui ?

Jeu de devinettes mobile, dans le navigateur, façon « jeu des lapins » / Heads Up, aux couleurs de Polycea.

## Comment jouer

1. Ouvrez le site sur votre téléphone et choisissez la durée (60, 90 ou 120 s).
2. Touchez **Jouer**. Sur iPhone, acceptez l'accès aux capteurs de mouvement.
3. Tournez le téléphone en paysage et posez-le sur votre front, écran vers vos coéquipiers.
4. Ils vous font deviner le mot affiché :
   - **baissez** le téléphone (écran vers le sol) : mot trouvé ✅
   - **levez** le téléphone (écran vers le plafond) : on passe ⏭️
5. Revenez à la verticale entre deux mots.

Sans capteur (sur ordinateur par exemple), touchez la moitié droite de l'écran pour valider et la moitié gauche pour passer, ou utilisez les flèches du clavier (↓/→ pour valider, ↑/← pour passer).

> Astuce : sur iPhone, « Partager → Sur l'écran d'accueil » permet de jouer en plein écran.

## Ajouter des expressions

Toutes les expressions sont dans [`words.js`](words.js) : ajoutez une ligne par expression.

## Technique

Site 100 % statique (HTML/CSS/JS, sans build), déployé automatiquement par Vercel à chaque push.

- La détection d'inclinaison utilise `deviceorientation` : `cos(beta) × cos(gamma)` donne la composante verticale de la normale à l'écran (0 = vertical, < 0 = écran vers le sol, > 0 = écran vers le plafond). Les seuils sont dans `game.js`.
- Les capteurs de mouvement exigent HTTPS, ce que fournit Vercel.

En local : `python3 -m http.server` puis http://localhost:8000.

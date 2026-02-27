# NQT — Not Quite Tavern — Liste Complète des Fonctionnalités (Extrême)

Bienvenue dans la documentation exhaustive de **NQT (Not Quite Tavern)**. Cette extension transforme l'interface de Google Gemini en un véritable moteur de Jeu de Rôle (RP) inspiré des meilleures fonctionnalités de *SillyTavern*, tout en restant parfaitement intégré au navigateur.

---

## 🛠️ Moteur de Lorebook (Grimoire) — Le Cœur du RP

Le Lorebook est un système de gestion de contexte dynamique qui injecte des informations pertinentes dans vos messages uniquement quand elles sont nécessaires.

### 🌓 Modes de Déclenchement (Trigger Modes)
- **Keyword (Mots-clés)** : Se déclenche de manière classique via une liste de mots-clés présents dans les derniers messages.
- **Constant** : L'entrée est systématiquement injectée dans chaque prompt, utile pour les règles de base ou les descriptions de monde permanentes.
- **Vectorized (Sémantique)** : Utilise l'IA (Transformers.js) pour comparer le sens de votre message avec le contenu de l'entrée. Se déclenche même si vous n'utilisez pas de mots précis, mais que le sujet est abordé.

### 🔍 Logique de Scan Avancée
- **Scan Depth (Profondeur de scan)** : Choisissez combien de messages précédents l'IA doit analyser pour trouver des mots-clés (réglable globalement ou par entrée).
- **Selective Keywords (Logique conditionnelle)** :
    - **AND** : Nécessite que plusieurs mots-clés soient présents simultanément.
    - **NOT_ANY** : Empêche le déclenchement si certains mots sont détectés.
    - **NOT_ALL** : Empêche le déclenchement si une combinaison spécifique est trouvée.
- **Recursive Scan (Récursion)** : Une entrée activée peut elle-même contenir des mots-clés qui en activent d'autres (profondeur de récursion configurable pour éviter les boucles infinies).

### ⏳ Effets Temporels (Timed Effects)
- **Sticky (Persistance)** : Une fois activée, l'entrée reste dans le contexte pour un nombre défini de messages, même si le mot-clé disparaît.
- **Cooldown (Délai de récupération)** : Empêche l'entrée de se réactiver trop rapidement après une utilisation.
- **Delay (Activation différée)** : L'entrée ne s'active qu'après un certain nombre de tours de chat.

### 🎲 Probabilité & Priorités
- **Probability** : Définissez un pourcentage de chance (0-100%) pour qu'une entrée s'active, ajoutant de l'imprévisibilité au récit.
- **Insertion Order (Ordre d'insertion)** : Gérez quelle information apparaît en premier si plusieurs entrées s'activent en même temps.
- **Token Budget** : Limite stricte de la taille du lore injecté pour éviter de dépasser les limites de Gemini.

---

## 🧠 Mémoire Vectorisée & IA Locale

L'extension embarque une intelligence artificielle locale pour gérer la mémoire sémantique sans envoyer vos données à des serveurs tiers.

- **Transformers.js Integration** : Utilise le modèle `paraphrase-multilingual-MiniLM-L12-v2` pour comprendre le français et d'autres langues.
- **Offscreen Processing** : Tout le calcul lourd des "embeddings" (vecteurs de sens) se fait dans un processus discret pour ne pas ralentir l'interface de Gemini.
- **Multi-chunk Embedding** : Les longues entrées de lore sont découpées en morceaux de ~400 caractères avec chevauchement pour garantir que l'IA repère le contexte, quelle que soit la longueur du texte.
- **Seuil de Similitude (Vector Threshold)** : Réglage précis de la sensibilité du déclenchement sémantique.

---

## 🎭 Gestion des Personnages (Cards)

- **Character Cards** : Importez et gérez vos fiches de personnages préférées.
- **Format Compatible** : Supporte les structures de cartes RP standards (V2/V3).
- **Active Card Switcher** : Changez de personnage à la volée directement depuis la barre latérale.

---

## 📝 Note de l'Auteur (Author's Note)

- **Position Personnalisée** : Injectez des instructions de style ou des rappels à une profondeur spécifique dans l'historique (ex: toujours à 2 messages du bas).
- **Style Directives** : Idéal pour forcer l'IA à écrire avec un certain ton, format ou niveau de langage (soutenu, familier, etc.).

---

## 🖥️ Interface Utilisateur (Sidebar & UI)

L'extension ajoute une barre latérale (Side Panel) riche en fonctionnalités directement dans Chrome :

- **Dashboard Temps Réel** : Visualisez en direct quelles entrées de lore sont actuellement actives.
- **Éditeur de Lore Intégré** : Créez, modifiez et testez vos entrées sans quitter votre conversation.
- **Toast Notifications** : Des alertes discrètes vous informent quand une entrée est vectorisée ou qu'un changement est sauvegardé.
- **Mode Édition Pro** : Formulaires détaillés pour régler chaque paramètre (Sticky, Cooldown, Logic, etc.).
- **Indicateur de Mémoire** : Affiche le nombre de tokens utilisés et le statut de la vectorisation.

---

## 🌍 Intégration Gemini & Domaines Supportés

- **Injection de Prompt Transparente** : L'extension intercepte vos envois sur Gemini pour y greffer silencieusement le lore et la mémoire avant que le message ne parte.
- **Compatibilité Multi-Modèles** : Fonctionne avec Gemini (Google), mais possède aussi des hooks pour OpenRouter et d'autres APIs via les host_permissions.
- **Sécurité & Confidentialité** : Toutes les données sont stockées localement via `chrome.storage.local`.

---

## ⚙️ Paramètres Globaux

- **Extension Master Switch** : Désactivez tout le système d'un clic si vous voulez repasser en mode "Gemini standard".
- **Language de Lore AI** : Configurez la langue cible pour les générations automatiques.
- **Budget de Tokens** : Contrôle total sur la consommation de contexte pour optimiser les performances de Gemini.

---
*Fin de la documentation exhaustive.*
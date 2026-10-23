# Insteon pour Gladys Assistant

Cette intégration relie Gladys à un réseau Insteon par le **Hub Insteon
2245**, sur votre réseau local. Elle lit les appareils liés au hub et ce
qu'ils signalent, et pilote les lumières et interrupteurs que vous déclarez
sûrs.

> Intégration non officielle, sans lien avec Insteon.
>
> **Jamais testée avec un vrai appareil** : elle a été écrite à partir de la
> bibliothèque pyinsteon (celle de Home Assistant) et testée seulement avec un
> hub simulé. Vos retours sont bienvenus.

## Ce que vous obtenez

| Appareil Insteon                                                              | Dans Gladys                                                                                                  |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Variateur (SwitchLinc, LampLinc, KeypadLinc, lumière du FanLinc…) déclaré sûr | une lumière : marche/arrêt et luminosité                                                                     |
| Interrupteur, module ou relais encastré déclaré sûr                           | un interrupteur (ou une lumière)                                                                             |
| Variateur ou interrupteur **non** déclaré sûr                                 | son état (et son niveau), en lecture seule, et des boutons « Allumer » / « Éteindre », désactivés par défaut |
| Détecteur de mouvement                                                        | mouvement, pile faible                                                                                       |
| Détecteur d'ouverture                                                         | ouverture, pile faible (détecteurs de porte)                                                                 |
| Détecteur de fuite                                                            | fuite                                                                                                        |
| Smoke Bridge                                                                  | fumée, monoxyde de carbone, pile faible                                                                      |
| I/O Linc                                                                      | l'entrée capteur et le relais, en lecture seule                                                              |
| Boutons de claviers, télécommandes, interrupteurs                             | le déclencheur de scène « Bouton Insteon »                                                                   |

Pas encore pris en charge : thermostats, serrures (MorningLinc), commande du
relais de l'I/O Linc (portes de garage), prises doubles (On/Off Outlet),
volets, délesteurs, X10, les modems USB ou série (PowerLinc Modem) et l'ancien
Hub 2242. Ils sont listés dans le statut de l'intégration.

## Mise en place

1. Donnez au hub une adresse IP fixe dans votre box.
2. Dans Gladys, ouvrez l'intégration et saisissez :
   - l'**adresse du hub** (son adresse IP) ;
   - le **nom d'utilisateur** et le **mot de passe** imprimés sur l'étiquette
     sous le hub (pas votre compte Insteon). Le mot de passe est gardé par
     Gladys dans sa base, jamais réaffiché, envoyé seulement au hub, jamais
     écrit dans les journaux. Le hub ne parle qu'en HTTP simple : tout
     appareil qui lit votre réseau local peut le lire ;
   - facultatif, l'**adresse Insteon du hub** (imprimée dessus). Vide, le hub
     trouvé à la première connexion est retenu.
3. Enregistrez, puis cliquez sur **Tester la connexion**.

À la première connexion, l'intégration lit la base du hub (les appareils qui
lui sont liés), puis demande à chaque appareil ce qu'il est. Les appareils sur
pile (détecteurs, télécommandes) dorment et ne répondent pas : **appuyez une
fois sur leur bouton set**, ou attendez leur prochain message (mouvement,
porte ouverte…), et ils apparaissent. Ajoutez ensuite les appareils depuis
l'onglet **Découverte**.

## Lumières et interrupteurs : déclarez-les sûrs

Une lumière ou un interrupteur dans Gladys obéit à Google Home, Alexa, au MCP
(« éteins tout ») et à toutes les scènes. Un interrupteur ou un variateur
Insteon peut commander n'importe quoi : une lampe, mais aussi une pompe, un
chauffage, un congélateur, une porte de garage. Un variateur ou un
interrupteur n'est donc une lumière ou un interrupteur **que si vous listez
son adresse dans « Appareils déclarés sûrs »**, par exemple :

```
1A.2B.3C, 4D.5E.6F light
```

Un variateur est toujours une lumière ; un interrupteur est un interrupteur,
ou une lumière s'il est suivi de `light`. Les autres montrent leur état, et
deux boutons « Allumer » et « Éteindre » qui ne marchent qu'une fois cochée
l'option **« Autoriser les boutons Allumer / Éteindre »**. Quand vous
déclarez un appareil sûr plus tard, ses nouvelles fonctionnalités
apparaissent dans la Découverte ; supprimez les anciennes dont vous ne voulez
plus (leur historique part avec elles).

## Commandes

Une commande part dans les 3,5 secondes ou pas du tout (« rien n'a été
envoyé »). Elle n'est confirmée que si l'appareil répond le niveau demandé ;
sinon Gladys affiche « envoyé, sans confirmation » et l'appareil est relu
2 secondes plus tard. Chaque commande est écrite dans les journaux de
l'intégration.

## Déclencheur de scène « Bouton Insteon »

Chaque appui sur un bouton de clavier, de télécommande ou sur un interrupteur
(appareil lié au hub) déclenche avec :

- `address` : l'adresse de l'appareil, en majuscules avec des points, comme
  sur son étiquette (`1A.2B.3C`) : elle est comparée telle quelle ;
- `button` : le bouton (groupe Insteon) : 1 pour un interrupteur, 1 à 8 sur
  un clavier ;
- `action` : `on`, `off`, `fast_on`, `fast_off` (double appui), `dim_start`
  (maintenu), `dim_stop` (relâché).

120 événements par minute au plus.

## Lectures et limites

- Le hub est lu deux fois par seconde (comme le fait pyinsteon) ; les
  appareils signalent leurs changements au fil de l'eau. À chaque intervalle
  de **lecture des états** (10 minutes par défaut), les variateurs,
  interrupteurs et I/O Linc sont relus. Un redémarrage de l'intégration ne
  relit jamais plus tôt.
- Les messages arrivés dans le hub juste avant l'envoi d'une commande peuvent
  être perdus (la mémoire du hub est vidée avant chaque message) ; la lecture
  suivante rattrape.
- **Un autre hub** qui répond à la même adresse IP (après un changement de
  box) : rien n'est lu ni envoyé tant que vous ne saisissez pas son adresse
  Insteon.
- **Mot de passe refusé** : l'intégration s'arrête et ne réessaie jamais
  seule. Corrigez le mot de passe, ou cliquez sur « Tester la connexion » quand
  le hub l'accepte.
- **Hub injoignable** : nouveaux essais après 10 s, 30 s, 1, 2, puis toutes
  les 5 minutes ; la pause est gardée après un redémarrage.

## Crédits

Le protocole du hub et la base des produits viennent de
[pyinsteon](https://github.com/pyinsteon/pyinsteon) (MIT, Tom Harris), voir
`THIRD_PARTY_NOTICES.md`.

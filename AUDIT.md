# Aplikacijos auditas — 2026-10-24

Peržiūrėtas paleidimas, modelių sąrašų paruošimas, preview gavimas ir cache,
siuntimo srautai, bibliotekos atnaujinimas ir puslapių veiksmai. Puslapių
atrankos taisyklės ir jų filtrai išlaikyti pagal kiekvieno puslapio paskirtį.

## Rastos ir pataisytos priežastys

1. **Pakartotinis paleidimas.** Nustatymų kalbos gavimas keitė callback
   priklausomybę ir pakartotinai vykdė paleidimo efektą. StrictMode jį taip pat
   kartojo. Paleidimas atskirtas nuo įvykių prenumeratų ir vyksta kartą.
2. **Nustatymų išsaugojimo kilpa.** Browse po perpiešimo pranešdavo tuos pačius
   filtrus; jų išsaugojimas sukeldavo kitą perpiešimą ir planuotojo patikras.
   Teste tai generavo daugiau kaip 1 000 nereikalingų išsaugojimų. Dabar
   nepakeisti filtrai neišsaugomi. Mėgstamiausių EA modelių pradinis nuskaitymas
   taip pat nebeišsaugo nustatymų ir nepaleidžia planuotojo prieš boot handshake.
3. **Kitų puslapių duomenys stabdė Browse.** Missing, Early access, Incomplete ir
   bibliotekos sąrašai nebepriklauso blokuojančiai Loading sekai. Sesija
   pradedama prieš papildomų sąrašų užkrovimą.
4. **N+1 ir perteklinės disko patikros.** Missing pakartotinai skaitė deferred
   lentelę kiekvienam tag review, darė atskiras ownership/allowlist užklausas ir
   tikrino tūkstančius preview failų vien tam, kad gautų versijų pavadinimus.
   Duomenys dabar gaunami grupėmis. Bibliotekos metaduomenų nuskaitymas
   nebetikrina kiekvieno preview failo; failus tikrina aiškus disk sync/repair.
   Periodinio versijų tikrinimo planavimas taip pat naudoja užklausų grupes.
5. **Preview mirksėjimas.** Paveikslas nebeslepiamas pasikeitus kandidatams ar
   cache URL. Ankstesnis dekoduotas paveikslas lieka, kol naujas paruoštas.
   Browse medžio raktas nebekinta persijungus aktyviai Harvest taisyklei.
   Pašalintas automatinis HTTP cache valymas po paleidimo; matomi Civitai
   preview išsaugomi diske ir naudojami po naujo proceso paleidimo.
6. **Preview eilės prioritetas.** Atidarius puslapį, jo jau eilėje esantis
   foninis preview prašymas pakeliamas į aktyvaus puslapio prioritetą.
7. **Dideli siuntimai.** Multipart ir Range probe buferiavo duomenis RAM;
   Range ignoruojantis serveris galėjo priversti probe persiųsti visą failą.
   Dabar probe skaito antraštes, dalys srautais rašomos į failą su backpressure,
   tikrinamos diapazonų antraštės ir gautų baitų skaičius. Atšaukimas sustabdo
   visus srautus. Prieš laikino failo šalinimą sulaukiama srautų uždarymo.
8. **Pasenę bibliotekos įrašai.** Palyginimas naudojo neegzistuojantį filePath
   ir neapėmė dalies metaduomenų. Modelio kelio, tipo, routing užrakto,
   ignored ir video modality pasikeitimai dabar pasiekia sąsają.
9. **Porinės kortelės.** High ir Low video resolveriai naudoja savo versijas;
   anksčiau abi pusės galėjo prašyti High video. Browse porų preview klaidos
   dabar pasiekia atitinkamos versijos atnaujinimo veiksmą.
10. **Kiti veikimo trūkumai.** Sutvarkyti Updates kontekstinio meniu parametrai,
    Ban On ×, Incomplete versijos/preview fallback, preview title paveldėjimas,
    vietinių failų URL su #/%/Unicode ir Help tekstų pasikartojantys React raktai.
    Suderintos IPC ir komponentų tipų sutartys; abi TypeScript patikros praeina.

## Matavimas su realios bazės kopija

Kopijoje: 3 485 bibliotekos versijos, 959 deferred įrašai, 500 tag review.
Tai funkcijų trukmės šiltame disko cache, ne viso proceso paleidimo laikas.

| Operacija | Prieš | Po |
|---|---:|---:|
| Missing / exclusions sąrašo paruošimas | 4 258 ms | 300 ms |
| Šio sąrašo SQL užklausos | 3 026 | 29 |
| Šio sąrašo exists/stat patikros | 47 518 | 397 |
| Visos bibliotekos metaduomenų skaitymas | 558 ms | 39 ms |
| Bibliotekos skaitymo exists/stat patikros | 6 310 | 0 |

## Patikrintos eigos

| Puslapis | Patikra |
|---|---|
| Browse | Sava rezultatų atranka, filtrų išsaugojimas tik po pakeitimo, taisyklių kaita, kontekstinis meniu, details preview |
| Library | Tik turimi modeliai, nepasikeitusių įrašų tapatybės išlaikymas, pasikeitusių laukų atnaujinimas, meniu ir details |
| Updates | Atskira naujos versijos kortelė, Ban On → × → patvirtinimas → tik tos versijos išskyrimas, meniu ir details |
| Early access | Taisykles atitinkantys Harvest įrašai; rankiniai ir favorites lieka nepriklausomai nuo taisyklių; pause nedingsta į Missing; meniu ir details |
| Missing | Atskirai pasirinktas All / paieška, išsaugant Session bans/pause filtro paskirtį; meniu ir details |
| Incomplete | Nežinoma versija (0), preview ir detalių versijos parinkimas, kontekstinis meniu |
| Tag Folders, Activity, Help, Settings | Puslapių atidarymas, neužblokuota sąsaja, nepakeistų nustatymų išsaugojimo nebuvimas, React klaidų / raktų perspėjimų nebuvimas |

Automatinės patikros:

- 24 regresijų testai ir 33 ankstesni paieškos, poravimo bei video modality testai.
- Sintetinė 1 000 versijų biblioteka: grupinės užklausos ir teisinga exclusions atranka.
- Du atskiri Electron procesai su atskirais HTTP profiliais ir bendru disko cache:
  antrame paleidime 0 naujų preview atsisiuntimų, 0 paveikslų dingimo kadrų.
- Visų 10 puslapių UI eigos; 0 neapdorotų renderer klaidų ir React atnaujinimo perspėjimų.
- Vietinis HTTP serveris: 96 MiB failo SHA256, progresas prieš pabaigą ir apie
  17–20 MiB buferių prieaugis; ignoruoti, neteisingi ir nutrūkę Range atsakymai;
  cancel, iš anksto atšauktas prašymas ir HTML autentifikacijos atsakymas.
- `npm run typecheck` ir `npm run build`.

`npm test` sujungia visas patikras. `scripts/profile-startup.cjs` be `--fixture`
naudoja tik aiškiai paruoštą `.tmp-test/startup-profile/inventory.db` kopiją.

UI testai naudoja valdomus IPC atsakymus, siuntimų testai — vietinį HTTP serverį.
Jie apima aprašytas eigas; konkretaus išorinio Civitai/CDN atsakymo, mokamos
prieigos ar visų galimų filtrų kombinacijų patvirtinimui reikia atitinkamų
integracinių scenarijų. Kompiuterio pakibimo priežastis OS lygmeniu nenustatyta;
kode rasti RAM ir perteklinio darbo šaltiniai pašalinti.

## Papildoma preview laukimo patikra

Naudota naujesnė realios bazės kopija: 3 502 versijos, 10 511 perskaitomų
Browse galerijos kortelių ir 211 Tag Folders taisyklių. Profilis atskiras;
Harvest nepaleidžiamas, tikri modeliai nekeičiami, HTTP užklausos blokuojamos.

- SQL nėra stebėto 10 s preview laukimo priežastis šiame matavime: Library
  metaduomenys 56–61 ms, Browse galerija 164–178 ms, 100 preview kortelių
  metaduomenys 16–41 ms. Naujausių 8 atsisiuntimų preview failai yra diske;
  jų egzistavimo/dydžio patikra truko iki 0,1 ms.
- Renderer CPU profilis parodė daugkartinį visų taisyklių skaidymą ir žymų
  lyginimą. Library antraštė tikrino visos bibliotekos žymas net Session
  filtre, kuriame tie jungikliai netaikomi. Šis darbas blokuodavo vaizdų
  parodymą ir sudarydavo grupinio užkrovimo įspūdį. Dabar taisyklių paieška
  indeksuota, išlaikant ankstesnį eiliškumą ir alias semantiką; jungiklių
  prieinamumas neskaičiuojamas, kai netaikomas, ir sustoja radus atsakymą.
- Prieš taisyklių optimizaciją pirmas Library preview pasirodė po 2,6–3,5 s
  (kai kuriuose bandymuose dar nebuvo parodytas po 2,5 s). Po pakeitimo
  ta pati biblioteka parodė pirmus preview per 356–373 ms.
  Papildomai išvengus tarpinio 100 kortelių montavimo prieš Session filtrą,
  galutiniame bandyme Session: 170–174 ms, Library All (100 kortelių): 591 ms,
  Browse trys realūs cache cover: 237 ms. Šio bandymo DB skaitymai 68/188 ms.
- Preview komponentas nebelaukia `img.decode()` pažado, galinčio užlaikyti
  jau įkeltą lazy paveikslą. Parodo kiekvieną sėkmingą `load` nepriklausomai;
  ankstesnį paveikslą išlaiko keičiant cover ir tikrina dabartinį elementą,
  todėl greito cache atsakymo nebeatmeta po mount efekto.
- Preview protokolas siunčia trūkstamą vaizdą per Chromium tinklo sluoksnį
  ir išsaugo jį atominiu pervadinimu. Ankstesniame kelyje Node bandymas
  galėjo laukti 10 s prieš Chromium fallback; to fallback vaizdas nebuvo
  įrašomas į ilgalaikį cache. Konkretaus CDN strigimo gyvame tinkle šiuo
  matavimu neatkartota; pats neišsaugantis fallback kelias pašalintas.
- Atsisiuntimas pirmiausia pernaudoja turimą Browse cache / vietinį preview,
  o tik jo neradęs siunčia iš CDN. Šiltas cache aplenkia siuntimų eilę.
- Teste su tyčia lėtu pirmu vaizdu kiti pasirodė po 71 ir 176 ms, pirmasis
  po 656 ms. Atskirame antrame Electron procese visi trys po 48 ms,
  0 naujų atsisiuntimų. Realūs trys Browse disko cache cover — apie 220 ms.

`node scripts/test-preview-electron.cjs --profile-live` papildomai skaito tik
aiškiai paruoštą `.tmp-test/preview-browser/live-inventory.db` kopiją ir
`live-config.json` be API rakto; CPU bei trukmių rezultatai lieka `.tmp-test`.
Tai puslapių paruošimo/preview parodymo matavimai, ne viso programos paleidimo
garantija kiekvienam tinklui, disko būsenai ar filtrų deriniui.

## Ban ir Forget atskyrimas — 2026-10-24

- **Ban / Unban** — atšaukiamas siuntimo draudimas, failai ir turimos bibliotekos
  versijos išsaugomi. Atskirų versijų draudimai turi savo lentelę; jie nebesutampa
  su Updates Skip ar Forget. Viso modelio Unban nepašalina atskirų versijų draudimų.
  Paprastas Unban vėl leidžia siųsti; aiškus „Unban & download“ detalėse taip pat
  įtraukia į siuntimą. Turimo modelio dar neatsiųstos versijos žinomas pasiūlymas
  po Unban iš karto grąžinamas į Updates. Puslapių paieškos ir atrankos lieka atskiros.
- **Forget this version / Forget entire model** — bendras patvirtinimas iš
  Library, Browse, Updates, Missing, Early access, Incomplete ir modelio detalių.
  Šalinami pasirinkti modelių failai, vietiniai preview, Swarm metaduomenys,
  Civitai sidecar failai, bibliotekos įrašai, eilės istorija ir susiję modelio
  metaduomenys. Kitos versijos ir kitų modelių naudojami bendri failai išlieka.
  „Forgotten“ filtro ir atkūrimo veiksmo sąsajoje nebėra; nauja paieška gali vėl
  aptikti modelį. Bendros Rules bei globalios žymų Ban/Pause taisyklės nesikeičia.
- Šalinimas atšaukia pasirinktus siuntimus. Atšauktas preview ar SHA256 tikrinimas
  nebegali vėliau įrašyti versijos atgal. Jei failo nepavyksta pašalinti arba
  diskas neprieinamas, rodoma klaida ir bibliotekos įrašas išlieka pakartojimui.
- Vienkartinė migracija panaikina senus aiškius viso modelio Forgotten įrašus.
  Senas versijos Forget ir Ban naudojo tą patį požymį, todėl šie dviprasmiški
  įrašai išsaugomi kaip atšaukiami versijos Ban. Migracija nepaleidžia failų
  trynimo; ankstesnė viso modelio Forget eiga jau šalindavo jo failus.
- `npm run test:models`: tikra izoliuota SQLite bazė ir bandomieji failai;
  Ban/Unban failų išsaugojimas, versijos/viso modelio Forget, seserinės versijos,
  bendri preview failai, pakartotinė paieška, nesėkmingas unlink, atšauktas
  failo patikrinimas, migracija ir atskiro proceso paleidimas.
- Electron UI patikra apima septynis Forget veiksmus visuose modelių puslapiuose
  ir detalėse, versijos Ban/Unban Library bei Browse ir rankinį siuntimą po Unban.
  Du procesai: 0 preview dingimo kadrų, antrame paleidime 0 naujų preview siuntimų.
  Paleidimo patikra su 1 000 versijų: bibliotekos metaduomenys viena užklausa,
  be failų egzistavimo patikrų; exclusions — 24 grupinės užklausos.

## Browse filtrų trumpalaikis praleidimas — 2026-10-24

- Pirmoji kortelių porcija galėjo pasirodyti prieš pilną Deferred sąrašą.
  Civitai paieškos kortelė ne visada turi early-access požymį, nors vietinėje
  bazėje ta versija jau laukia prieigos. Be to, siuntimo eilės kortelės buvo
  pridedamos po pagrindinio filtravimo ir galėjo sugrąžinti paslėptą modelį.
- Kiekviena siunčiama Browse rezultatų porcija dabar gauna dabartines Owned,
  modelio/versijos Ban ir vietinio laukimo būsenas iš SQLite. Naudojami tik ID,
  keturios grupinės užklausos, be preview ar bibliotekos failų tikrinimo.
  Cache atkūrimas taip pat nebeskaito visų bibliotekos metaduomenų vien ID gauti.
- Hide owned / excluded / awaiting taikomi ir eilės kortelėms. Eilės kortelė
  pernaudoja galerijos būsenas, o atskirai išlikusi eilės access klaida taip pat
  laikoma laukimu. Aiški paieška ir toliau turi savo ankstesnę filtrų išimtį.
- Nauja laukimo būsena paslepia kortelę dar prieš pilno Deferred įvykio gavimą.
  Gavus pilną sąrašą, Browse vietinio laukimo požymiai atnaujinami ir pašalinami
  pasibaigus laukimui. Naujas aiškus API `false` pakeičia seną early-access
  požymį, išlaikant preview ir kitus turtingesnius kortelės metaduomenis.
- Du Electron procesai: 0 paslėptų kortelių pasirodymo kadrų prieš/po duomenų
  užkrovimo ir vėluojant naujos laukimo būsenos įvykiui; nuėmus Hide awaiting,
  laukimo kortelės vėl rodomos. Išliko 0 preview dingimo kadrų ir 0 naujų preview
  siuntimų antrame procese. 1 000 versijų būsena: apie 1 ms, 4 SQL užklausos,
  0 failų egzistavimo/dydžio patikrų. Praėjo 25 regresijų ir 33 bendrieji testai.

## Early access klaidingas atrakinimas ir Browse — 2026-10-24

- Regresijos testu atkartota priežastis: mini API atsakymas galėjo sakyti
  `Public`, o pilnas versijos atsakymas vis dar turėti būsimą atrakinimo datą.
  Ankstesnis papildomas patikrinimas vertino tik `paidAccess`, todėl iškviesdavo
  atrakinimą ir grąžindavo modelį į eilę. Nepavykęs papildomas API patikrinimas
  taip pat galėjo būti palaikytas atrakinimu. Tai paaiškina laikiną modelio
  grįžimą į Browse iki kito siuntimo bandymo ir pakartotinio atidėjimo.
- Žinoma būsima data nebeatšaukiama vien mini atsakymu. Patikrinimai leidžiami
  ir prieš terminą, nes kūrėjas gali atrakinti anksčiau. Atrakinimui būtinas
  pilnas tos pačios versijos API atsakymas su aiškia `Public` būsena ir be
  prieigos ribojimo. Klaida ar išnaudotas užklausų limitas palieka modelį laukime.
  Pilnų užklausų limitas skaičiuoja kiekvieną bandymą; dar nepatikrinti įrašai
  kitą kartą tikrinami pirmiau, kad mokami modeliai neužlaikytų kitų įrašų.
- Ta pati prieigos klasifikacija naudojama Browse kortelėse, taisyklių
  siuntimo atrankoje ir siuntimo tarnyboje. Naujausios versijos trūkstamą būseną
  papildo modelio lygio `EarlyAccess`; atskira aiškiai vieša seserinė versija
  neužblokuojama. `paidAccess.endsAt` išsaugoma kaip laukimo data.
- Būsima data saugoma ir tiesioginio eilės perkėlimo, cache požymio išvalymo
  bei „ready for pipeline“ keliuose. Browse Hide awaiting ir siuntimui tinkamų
  modelių skaitikliai ją įvertina net gavę prieštaringą `isEarlyAccess=false`.
  Rankinis Retry išlieka atskiras veiksmas; automatinis siuntimas datos neapeina.
- Praėjo 31 regresijų ir 33 bendrieji testai, abi TypeScript patikros ir
  `npm run build`. Tikroje izoliuotoje SQLite patikrinti būsimos datos
  išsaugojimas, užblokuotas perkėlimas į eilę, perkėlimas po API patvirtinimo,
  grupinė atranka ir siuntimo tarnybos atidėjimas prieš papildomas užklausas.
- Du Electron procesai: 0 paslėptų kortelių pasirodymo kadrų, įskaitant kortelę
  su būsima data ir abiem false požymiais; 0 preview dingimo kadrų. Antrame
  procese 0 naujų preview siuntimų, trys cache preview parodyti po 46 ms.
  1 000 versijų Browse būsenos patikra: 1 ms, 4 SQL užklausos, 0 failų patikrų.
  Tai izoliuotų duomenų rezultatai; gyvas vartotojo profilis nepaleistas ir nekeistas.

## Galerijos ir eilės įvykių lenktynės, Browse ženkliukas — 2026-10-24

- Išplėstame Electron teste atkurtas mirktelėjimas, kurio ankstesnis testas
  neapėmė: nauja eilė jau matoma, o React `useDeferredValue` dar rodo ankstesnę
  Browse galerijos porciją. Eilės kortelė sukuriama be naujausių Owned, Ban ir
  Awaiting požymių. Po perėjimo kortelė pasislepia, tačiau iki jo spėja pasirodyti.
  Atkartoti Owned, excluded, awaiting ir būsimos datos kortelių pasirodymai.
- Galerijos atvaizdavimas toliau atidedamas našumui, tačiau filtravimo požymiai
  ir eilės kortelių metaduomenys imami iš naujausios gautos galerijos. Atskirai
  tikrinamas eilės prieigos klaidos požymis, net jei ta kortelė galerijoje jau yra.
- Automatinėje aktyvioje eilėje dar nepatikrinta prieiga pažymima prieš siunčiant
  Browse porciją. Su Hide awaiting kortelė neparodoma net Crawl IPC aplenkus eilės
  IPC. Vien metaduomenų progreso nepakanka: tikri modelio baitai patvirtina
  siuntimą. Tam pernaudojamas siuntimo tarnybos progresas, papildomų API užklausų
  kiekvienai kortelei nėra. Globaliai pristabdytos eilės vieši kandidatai vien
  dėl Pause nelaikomi prieigos laukiančiais. Aiškios paieškos išimtis išsaugota.
- Eilės struktūros pranešimai dabar apima prieigos patvirtinimo ir klaidos
  pasikeitimą. Vien baitų progresas vis tiek neperfiltruoja visos galerijos.
  Browse ženkliukas vertina vietinį laukimą, būsimą datą, aktyvų prieigos
  tikrinimą ir baigtus įrašus; vėluojanti Library ar Deferred porcija neturi
  sukurti klaidingo planuojamo siuntimo skaičiaus.
- Ankstyvas atrakinimas aptinkamas tikrinant ir būsimą terminą turinčius įrašus.
  Tik pilnas aiškus Public atsakymas gali pakeisti seną datą; jeigu vietinis
  įrašas po užklausos pradžios pasikeitė, pavėluotas patvirtinimas atmetamas.
  Išvaloma ir cache, ir atminties galerijos būsena. Nepilnas Public mini,
  klaidingas versijos ID arba API klaida palieka modelį laukime.
- Praėjo 34 regresijų, 33 bendrieji, tikros izoliuotos SQLite ir siuntimo eilės
  testai. Du Electron procesai: 0 paslėptų kortelių pasirodymo kadrų esant
  skirtingai galerijos/eilės įvykių tvarkai, 0 preview dingimo kadrų; antrame
  procese 0 naujų preview siuntimų. Nuėmus Hide awaiting matomos šešios
  bandomosios kortelės; Owned ir excluded lieka paslėptos.
- Abi TypeScript patikros ir build sėkmingi. 1 000 versijų Browse būsenos
  paruošimas: 1 ms, 4 SQL užklausos, 0 failų patikrų. Vartotojo profilis tik
  skaitytas diagnostikai; testai jo būsenų ir failų nekeitė.

## Siuntimų juosta ir vien data paremtas pakartojimas — 2026-10-24

- Juosta turėjo atskirą atranką: queued/downloading buvo rodoma iškart, o
  deferred Early access buvo rodoma, jei atrakinimo diena yra šiandien, net
  kai tikslus laikas dar ateityje. Atsiradus vienam klaidingai queued įrašui,
  kartu galėjo pasirodyti visa šiandienos laukiančių modelių grupė.
- Juostai, jos dock konteineriui, būsenos juostos skaičiams ir Browse ženkliuko
  eilės daliai naudojama bendra matomų siuntimų atranka. Early access/auth/
  forbidden laukimas nerodomas nei pagal dieną, nei pagal grubią queued būseną.
  Automatinis metaduomenų tikrinimas ir senas nepatvirtintas eilės momentinis
  vaizdas nesukuria aktyvaus siuntimo. Tikri modelio duomenys parodo siuntimą;
  sustabdytos rankiniu būdu pasirinktos viešos eilės ir įprastų klaidų valdymas
  lieka prieinami. Pavėluotas Deferred sąrašas neuždengia jau vykstančio srauto.
- Suėjęs terminas dabar reiškia poreikį tikrinti API, o ne leidimą automatiškai
  bandyti siųsti. SQLite saugomas atskiras `access_confirmed_at`, kurį suteikia
  tik pilnas Public patvirtinimas. „Ready“ nebeįrašo dirbtinės praeities datos.
  Senos praeities datos ir Ready tekstai be patvirtinimo automatiškai nekelia
  modelio į eilę. Nauja prieigos klaida atšaukia patvirtinimą; preview/metaduomenų
  atnaujinimas negali jo suteikti ar atkurti iš pasenusios objekto kopijos.
- Tiesioginis ir grupinis automatinis retry tikrina patvirtinimą. Siuntimo
  tarnybos iškvietimą papildomai saugo pačios eilės tikrinimas, jei iš disko
  atkurta pasenusi queued būsena. Ankstyvo atrakinimo API patikros išlieka;
  aiškus rankinis Retry tebėra atskiras veiksmas.
- Grupinis retry laukiančių modelių sąrašą skaito vieną kartą į Map. Anksčiau
  kiekvienam eilės įrašui buvo kartojamas pilnas SELECT ir visų eilučių
  dekodavimas. Izoliuotoje SQLite patikrinta viena tokia užklausa 12 pasenusių
  early_access/auth/forbidden įrašų, 0 perkėlimų ir 0 siuntimo tarnybos iškvietimų.
  Patikrintas patvirtinimo išlikimas po restart bei jo saugus atšaukimas.
- Visos App Electron testas apima queued įvykį prieš Deferred duomenis,
  šiandien ateityje ir praeityje esančius terminus bei mokamą prieigą be datos.
  Abiejuose procesuose: 0 juostos pasirodymo kadrų ir 0 klaidingo Browse ženkliuko
  kadrų, kai visi įrašai laukia prieigos. Bandomasis realaus modelio srautas
  teisingai parodo juostą ir vienetą, įskaitant suskleistą rodinį bei minimal,
  horizontal ir grid išdėstymus. Nutraukus srautą nelieka tuščio dock ar ženkliuko.
- Praėjo 35 regresijų, 33 bendrieji, izoliuotos SQLite ir Electron testai,
  abi TypeScript patikros bei build. 1 000 versijų Browse būsena: 1 ms,
  4 SQL užklausos, 0 failų patikrų. Antras Electron procesas: 0 naujų preview
  atsisiuntimų. Vartotojo profilio šie testai nekeičia.

## Paruoštų siuntimų skaičius ir stabilūs kortelių veiksmai — 2026-10-24

- Browse skaičiavo ne tik eilę, bet ir neatsiųstas galerijos/cache korteles,
  todėl po paskutinio siuntimo galėjo kelioms sekundėms sugrįžti vienetas.
  Dabar skaičiuojamos tik queued/downloading versijos, kurių pilni prieigos,
  failo ir išvesties aplanko patikrinimai baigti (`downloadReady`), arba jau
  patvirtintas tikras modelio duomenų srautas. Pradiniai API/metaduomenų
  tikrinimai, žinomi prieigos apribojimai, nepavykę ir užbaigti įrašai
  nesukuria ženkliuko. Galerijos ir bibliotekos atnaujinimo nereikia laukti.
- Pasirengimo ir pirmo modelio duomenų gavimo pokyčiai pranešami iškart;
  baitų progreso pranešimai lieka ribojami. Retry/restart panaikina ankstesnį
  pasirengimą, Pause išlaiko jau paruoštą eilę. Naujo modelio/Updates kilmė
  fiksuojama įdedant į eilę: pirmos pack versijos užbaigimas neperkelia
  likusių siuntimų į kitą skaitiklį. Tam nepridedama naujų Civitai užklausų.
- Skaičius turintiems skirtukams rezervuota pastovi vieta; Browse dešinėje
  palikta papildomai vietos. Library +N ženkliukas po užbaigimo taip pat
  nebestumdo likusio meniu.
- Missing sėkmės/prieigos pranešimas turėjo sąlyginę eilutę virš galerijos,
  o Allowed kortelė prarasdavo mygtukų eilutės aukštį. Pranešimo vieta dabar
  pastovi, peržiūrėta kortelė išlaiko išmatuotą aukštį iki išėjimo iš Missing.
  Aukščio stebėjimas įjungtas tik Missing kortelėms. Taip pat pataisyta
  Unban atranka, kai tas pats modelis turi ir whole-model, ir kitos versijos
  ban: laikoma būtent paspausta bannedManual kortelė.
- Library meniu yra vienas BAN veiksmas. Lange galima pasirinkti pažymėtą
  versiją arba visą modelį; Cancel nekeičia duomenų. Tą patį langą atidaro
  Ban On kortelės mygtukas. Ban palieka failus, Forget išlieka atskiras.
- Electron testas dabar įkelia abu tikros aplikacijos CSS failus. Abiejuose
  atskiruose procesuose: skaičiaus eiga 2 → 2 (Pause) → 2 (siunčiama) → 1 →
  1 (eilės įrašo pašalinimas) → 0, skirtukų poslinkis 0 px. Po trijų nuoseklių
  Missing Allow/Unban veiksmų: 12 kortelių, 0 px poslinkio ir 0 pakeistų DOM
  elementų. Patikrinti BAN Cancel, versijos ir viso modelio pasirinkimai,
  whole-model Unban, kitų versijų ir vietinių bibliotekos įrašų išlaikymas.
- Praėjo 36 regresijų ir 33 bendrieji testai, izoliuoti SQLite/modelių
  veiksmai, vietinio HTTP serverio siuntimai (multipart, fallback, abort,
  HTML auth), abu Electron procesai, abi TypeScript patikros ir production
  build. 1 000 versijų Browse būsena: 1 ms, 4 SQL užklausos, 0 failų patikrų.
  Antrame Electron procese 0 naujų preview siuntimų; preview dingimo kadrų 0.

## Nuolatinis Forget sprendimas — 2026-10-24

- Patikslinta Forget semantika: failai ir darbiniai įrašai pašalinami, tačiau
  atskiroje `forgotten_selections` lentelėje išlieka modelio/versijos ID ir laikas.
  Šis sprendimas nepriklauso nuo Ban/Unban, Updates Skip ir Pause. Visas modelis
  reiškia ir jo būsimas versijas; viena versija neblokuoja kitų modelio versijų.
  Forgotten atkūrimo filtro ar Unforget veiksmo nepridėta.
- Žyma įrašoma toje pačioje SQLite transakcijoje kaip duomenų valymas, tik po
  sėkmingo vietinių failų pašalinimo. Nesėkmingas unlink neįrašo Forget žymos ir
  palieka Library įrašą problemai ištaisyti. Viso modelio sprendimas sutraukia
  ankstesnes to modelio versijų žymas į vieną.
- Apsaugoti Harvest, Browse/search, Updates/Always update, Early access,
  Incomplete ir eilės atkūrimas. Tiesioginis ar force siuntimas, sena rankinė
  eilė ir Unban negali apeiti Forget. Pavėlavęs cache/metaduomenų ar siuntimo
  užbaigimas negali vėl sukurti pašalintos versijos. Bibliotekos failų per
  Explorer pašalinimas savaime nesukuria Forget sprendimo.
- Narystė pamirštų ID rinkiniuose talpinama atmintyje ir perrenkama tik po
  pakeitimo / DB uždarymo. Kortelių ir eilės tikrinimams nepridedama SQL
  užklausos kiekvienam modeliui. Likę ankstesni pasenę būsenų įrašai nerodomi
  Updates, Early access, Incomplete ar Missing peržiūrose.
- Vienkartinė migracija išsaugo aiškias senas whole-model Forgotten žymas ir
  atkuria ankstesnius sėkmingus Forget iš išlikusių struktūrizuotų Activity
  įrašų. Sutapti turi manual šaltinis, tikslus operacijos tekstas ir ID; panašus
  tekstas ar nesutampantys ID nelaikomi sprendimu. Istorijos nebuvimo atkurti
  negalima. Migracija savavališkai netrina jau iš naujo atsiųstų failų.
- Atnaujinti patvirtinimai ir EN/LT pagalba: paieška nebeatkuria pamiršto
  modelio. Ban tebėra atšaukiamas ir palieka vietinius failus.
- Izoliuoti SQLite testai tikrina versijos ir viso modelio atvejus, du
  atskirus procesus, būsimas versijas, Unban/force/atkurtos rankinės eilės
  apėjimo bandymus, naują API paiešką, pasenusį cache, pavėlavusį addVersion,
  nepavykusį unlink, istorijos migraciją ir jos klaidingų sutapimų atmetimą.
  Kitos versijos ir nesusiję Library failai išlieka.
- Praėjo SQLite/modelių veiksmai abiejuose procesuose, 36 regresijų ir 33
  bendrieji testai, abiejų Electron procesų puslapių/preview patikros,
  TypeScript ir production build. 1 000 versijų Browse būsena: 1 ms,
  4 SQL užklausos, 0 failų patikrų. Testai vartotojo profilio nekeitė.

## Swarm metaduomenys ir netinkamų siuntimų taisymas — 2026-10-24

- Civitai `metadata.size = full/pruned` buvo klaidingai rašoma į
  `modelspec.resolution`. SwarmUI šį lauką skaito kaip du sveikuosius pikselių
  matmenis. Nauji metaduomenys priima tik teigiamą `plotisxaukštis` reikšmę;
  nežinoma rezoliucija neįrašoma. Failo variantas lieka atskiru metaduomeniu.
- Esamus klaidingus resolution laukus taiso Settings → Sync library from disk,
  išsaugodamas kitus JSON laukus ir nekeisdamas svorių. Tam nereikia Civitai API.
  Inventoriuje normalizuojamos ir senos netinkamos resolution reikšmės.
- Single ir multipart siuntimas tikrina `.safetensors` antraštę, UTF-8 JSON,
  metaduomenų tipus ir vientisus tenzorių intervalus prieš galutinį rename.
  Fragmentuotas HTML atmetamas ir kitų svorių formatų siuntimuose. Netinkamas
  atsakymas nepakeičia jau esamo gero failo; laikinas failas išvalomas.
- Kai Civitai pateikia SHA256, naujo siuntimo turinys privalo su juo sutapti.
  Naudojamas ribotos atminties srautas, o ne viso modelio buferis. Be Civitai
  etalono SHA256 neskaičiuojamas. Automatinis Sync hash/backfill ir vietinių
  modelių fingerprinting pašalinti iš vykdymo kelio. Rankinė Verify hashes
  tikrina tik atpažintus Civitai modelius su pateikta kontroline suma; etaloną
  gauna pagal versijos ID. By-hash užklausų metodai pašalinti iš API kliento.
- Pilnas Sync tikrina esamų svorių turinį, o ne sprendžia pagal mažą dydį.
  Įrodytai netinkamas failas nebelaikomas owned, paliekama `.invalid-*` kopija
  ir tinkama Civitai versija įtraukiama į įprastą siuntimo eilę. Nesėkmė ar
  nebepasiekiama versija owned būsenos neatkuria. Ban, Forget ir Pause lieka
  atskiros funkcijos; jų ribojimų taisymas neapeina.
- Užrakintas netinkamas originalas nesustabdo owned būsenos pašalinimo.
  Pakaitalas gali būti siunčiamas kitu laisvu pavadinimu; originalo perkėlimo
  klaida išlieka Activity. Neįskaitomas/offline failas nėra įrodytas sugadinimas.
  Importas ir adoption negali neteisingo failo vėl pažymėti turimu.
- Patikros vykdomos tik pagal poreikį; paleidimui nepridėtas bibliotekos failų
  skaitymas. Sync tarp failų atiduoda vykdymą įvykių ciklui. Testai naudoja
  izoliuotus profilius, SQLite ir vietinį HTTP serverį; tikra biblioteka bus
  taisoma naudotojui paleidus Sync.
- Praėjo 39 regresijų ir 33 bendrieji testai, SQLite/modelių veiksmai ir
  restarto patikra, single/multipart siuntimai bei SHA256 neatitikimai,
  abiejų Electron procesų sąsajos/preview patikros, abi TypeScript patikros
  ir production build. 96 MiB siuntimui naudota apie 19 MiB JS buferių.
  1 000 versijų Browse būsena: 1 ms, 4 SQL užklausos, 0 failų patikrų.

## Pilno Sync turimų preview persiuntimo regresija — 2026-10-24

- `repairMissingPreviews` pažymėdavo trūkstamą Swarm thumbnail net tada,
  kai `.preview.jpg` jau buvo diske. Dėl to pilnas Sync galėjo iš naujo
  spręsti URL, siųsti preview ir perrašyti metaduomenis kiekvienam modeliui.
- Esamas preview dabar praleidžia nuotolinį paveikslėlio taisymą. Trūkstami
  NSFW metaduomenys papildomi atskirai, o iš tikrųjų dingęs preview atkuriamas.
- Regresinis testas prieš pataisą atkūrė neteisingą persiuntimą; po pataisos
  tikrina 0 tinklo užklausų esamam preview, vieną dingusio failo atkūrimą,
  jo panaudojimą kito Sync metu ir atskirą NSFW papildymą be preview siuntimo.

## Yield — tik pilnai užbaigti siuntimai — 2026-10-24

- Senas renderer skaitiklis įsimindavo jau queued/downloading versijas ir jų
  nebeatimdavo po Missing, awaiting ar fail. Todėl Yield nebuvo sėkmės rodiklis.
- Skaičiavimas perkeltas į pagrindinio proceso siuntimo užbaigimą. Darbininkas
  aiškiai atskiria naują svorių siuntimą nuo esančio failo adoption; sėkmės žyma
  grąžinama tik po validacijos, metaduomenų ir inventoriaus įrašo išsaugojimo.
  Set pagal versijos ID neleidžia dubliuoti vienos versijos sėkmės.
- Sesijos skaičius laikomas atmintyje, grąžinamas eilės snapshot ir completion
  pranešime. Jis neįrašomas į queue DB ir neatkuriamas iš senų queue įrašų.
  Renderer gauna teisingą skaičių ir kai done eilutė jau pašalinta; pakartotiniai
  ar pavėlavę pranešimai nedubliuoja ir nesumažina sesijos skaitiklio.
- Library sesijos pranešimai taip pat atskirti nuo adoption. Updates laikinos
  pipeline narystės skaičiavimas išlieka atskiras nuo sėkmingų siuntimų Yield.
  Pakeisti EN/LT paaiškinimai ir README.
- Izoliuotas tikro worker, HTTP ir SQLite testas: 8 Missing → Yield 0;
  4 validuoti, į Library išsaugoti siuntimai → 1, 2, 3, 4; adoption → lieka 4;
  naujas queue procesas → 0. Chromium patikra abiejose sesijose tikrina laukimą,
  klaidas, modelio/preview/Swarm fazes, dvigubą IPC, pruned queue ir tuščią Browse.
- Praėjo 40 regresijų ir 33 bendrieji testai, tikri izoliuoti siuntimai/SQLite,
  abu atskiri Chromium procesai, abi TypeScript patikros ir production build.

## Papildoma skenavimo ir galerijos patikra — 2026-10-24

- Paleidimo metu tikrinamas kiekvienos įjungtos Browse taisyklės pirmas API
  puslapis, nelaukiant newest-peek intervalo. Tai nėra visų Civitai base modelių
  paieška. Dabartiniame profilyje abi įjungtos taisyklės jau turi užbaigtą
  katalogo perėjimą ir neturi likusių cursor; po pradinio patikrinimo naujienos
  tikrinamos nustatytu 10 min. intervalu. Pilnas bibliotekos Sync paleidimo
  metu nevykdomas; bibliotekos versijų foninė patikra atidėta 45 s.
- Nebaigto katalogo puslapiai tęsiami ir kai neaptinkama naujų siuntimų.
  Pašalinta perteklinė 250 ms pauzė; bendras 200 ms API užklausų pradžios
  intervalas ir klaidų/retry pauzės išliko. Pradinis kelių taisyklių patikrinimas
  nebelaukia ankstesnės taisyklės vietinio galerijos/cache paruošimo.
- Modelio #3018265 / versijos #3426831 įraše rasti trys paveikslėlių CDN asset
  ID ir papildomi disk-cache adresai. Plokščias fallback adresų sąrašas buvo
  klaidingai naudojamas kaip galerijos skaidrių sąrašas. Load previews dabar
  gauna pilną pasirinktos versijos galeriją, nesinaudoja daliniu kortelės
  sąrašu, grupuoja cache/CDN šaltinius ir nesiskolina kitos versijos paveikslų.
  Išsaugotas Library viršelis nepridedamas kaip papildoma galerijos skaidrė.
- Preview navigacija ir All tinklelis naudoja tikrą paveikslėlių skaičių;
  alternatyvūs to paties Civitai asset transformai turi bendrą tapatybę.
  Kiekvienas paveikslas išlaiko vietinį ir nuotolinius atsarginius šaltinius.
  Preview išsaugojimas taip pat nekeičia galerijos paveikslų skaičiaus.
- Naujas modelis be versijos jau buvo nukreipiamas į Incomplete prieš kuriant
  Browse kortelę. Tačiau senas jo Browse cache įrašas galėjo pasirodyti po
  restarto. Žinomi Incomplete ID dabar pašalinami prieš cache kortelių
  paskelbimą ir prieš siunčiant Browse puslapius. Narystė skaitoma kartu su
  Ban ID, išlaikant 4 bendras SQL užklausas ir nulį bibliotekos failų patikrų.
  Tai neįrodo, kad kiekviena pradingstanti kortelė pateko į Incomplete:
  pilnas siuntimo patikrinimas dar gali nustatyti neprieinamą versiją ar
  prieigos ribojimą, kurio nebuvo paieškos atsakyme.
- Regresijos tikrina tris puslapius be naujų siuntimų, lėtą galerijos callback,
  dvi pradinio tikrinimo taisykles, Incomplete cache atranką, cache/CDN grupes
  ir griežtą versijos galeriją. Chromium testas dviejuose procesuose tikrina
  1/3 → 2/3 → 3/3, atsarginį šaltinį, All tinklelio tris paveikslus ir preview
  išsaugojimą be skaitiklio padidėjimo; antras procesas nesiunčia paveikslų.
  Patikros naudoja izoliuotas duomenų bazes ir failus, nekeičia naudotojo
  bibliotekos ir nepaleidžia tikro modelių Sync.
  Praėjo 43 regresijų ir 33 bendrieji testai, SQLite/Electron patikros,
  abi TypeScript patikros ir production build. Paleidimo fixture su 1 000
  bibliotekos versijų: Browse narystė 1 ms, 4 SQL užklausos, 0 failų patikrų.

## Awaiting skaitiklių apimtis — 2026-10-24

- Browse katalogo Awaiting ir Early access All skaičiavo skirtingas aibes.
  Browse apima tik esamas katalogo korteles; Early access apima visą dabartines
  taisykles atitinkantį sąrašą, manual ir favorites versijas. Banned/paused
  tikrinami prieš priskiriant Browse kortelę Awaiting kategorijai. Early access
  All pagal numatytąsias Hide banned / Hide paused nuostatas jų taip pat nerodo.
- Tik skaitymo diagnostika: 925 taisykles atitinkantys deferred įrašai,
  686 atmesti pagal tagų politiką, 9 not-found, 230 tinkamų laukiančių versijų;
  rankiniais banais pažymėtų versijų tarp šių 230 nebuvo. Anksčiau vartotojo
  matytos 208 momentinės Browse būsenos DB neatkuria, todėl skirtumas 22 nėra
  priskiriamas konkrečiai banų ar pause grupei.
- Aptikta atskira klaida: not-found deferred narystė ir senas isEarlyAccess
  požymis galėjo kartu išlaikyti kortelę Browse Awaiting skaičiuje. Tokios
  versijos dabar pašalinamos prieš cache paskelbimą, iš siunčiamų puslapių,
  renderer atvaizdavimo ir katalogo statistikos. Deferred įrašas išlieka
  patikrinimui/retry; vien dėl statistikos nedaromas Ban ar Forget.
- Užrašas pakeistas į Awaiting in Browse, pridėtas EN/LT paaiškinimas.
  Bendras Early access pranešimas naudoja actionable kiekį, įskaitant owned
  bei modelio/versijos banų patikrą, vietoje visų deferred eilučių skaičiaus.
- SQLite testas tikrina tikrą access gate kartu su owned, manual Ban, paused
  tag, banned tag ir stale not-found kortelėmis. Chromium abiejuose procesuose
  patikrino Browse 1, Early access All 2 ir bendrą pranešimą 2; paused, banned
  ir not-found įrašai skaičių nepadidino. Browse būsenai išliko 4 bendros SQL
  užklausos ir 0 failų patikrų su 1 000 bibliotekos versijų.

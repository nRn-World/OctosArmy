# Bidra till OctosArmy 🤝

Välkommen! Vi är jätteglada att du vill vara med och göra OctosArmy till det absolut bästa fler-agent-systemet i open source-världen. Här hjälps hundratals kodare åt för att göra programmet stabilare, säkrare och vassare.

## Hur du kan bidra

### 🐛 Rapportera Buggar
Skapa en **Issue** under Issue-fliken om du hittar något som inte fungerar:
- Ange din Windows-version.
- Beskriv vad Scouten eller Kodar-agenten gjorde fel.
- Inkludera agentloggar från uppdragskonsolen om möjligt.

### 💡 Föreslå Funktioner
Har du en idé för en ny agent, ett nytt UI-tema, eller säkrare filhantering? Starta en diskussion i en Issue!

### 🛠️ Koda och skicka Pull Requests (PR)
1. Klicka på **Fork** uppe i högra hörnet på GitHub.
2. Klona repot lokalt: \`git clone https://github.com/nRn-World/OctosArmy.git\`
3. Skapa en ny branch för din fix: \`git checkout -b fix-min-coola-funktion\`
4. Installera beroenden och testa lokalt: \`npm run dev:electron\`
5. Gör dina ändringar och commita: \`git commit -m "Lagt till cool funktion"\`
6. Pusha till din Fork: \`git push origin fix-min-coola-funktion\`
7. Öppna en **Pull Request** mot vår \`main\`-branch.

## Våra Kodregler
- **Agenter får aldrig gissa**: Om du lägger till nya funktioner för AI:n, upprätthåll policyn att agenter alltid måste validera sökvägar till 100%.
- Tänk på säkerheten: Alla modifikationer i \`fs\`-modulerna måste passera \`validateSandboxPath\`-skyddet.

Tack för att du är en del av communityt! 🎉

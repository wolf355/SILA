import { Component, OnDestroy, PLATFORM_ID, inject, input, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { ApiService } from '../../services/api.service';
import {
  PHRASES_DECLENCHEUR,
  TEXTE_PAR_DEFAUT,
  construireTranscription,
  positionApresDeclencheur
} from './urgence-vocale.utils';

type EtatUrgence = 'inactif' | 'ecoute' | 'envoi' | 'envoye' | 'erreur';

@Component({
  selector: 'app-urgence',
  template: `
    <div class="commandes">
      <button class="sos" (click)="declencherManuellement()">🆘 EMERGENCY</button>
      <button class="veille" [class.actif]="veilleActive()" [disabled]="!vocalDisponible()" (click)="basculerVeille()">
        🎙 Voice trigger: {{ veilleActive() ? 'ON' : 'OFF' }}
      </button>
      @if (veilleActive()) {
        <span class="aide">Say "emergency" or "mayday"</span>
      }
      @if (erreurMicro()) {
        <span class="aide erreur">{{ erreurMicro() }}</span>
      }
      @if (!vocalDisponible()) {
        <span class="aide">Voice is not supported in this browser (use Chrome or Edge).</span>
      }
    </div>

    @if (etat() !== 'inactif') {
      <div class="ecran" role="alertdialog" aria-label="Emergency mode">
        @if (etat() === 'ecoute') {
          <h1>EMERGENCY MODE</h1>
          <p class="consigne">
            {{ microActif() ? '🎙 Listening. Speak now: say what is happening.' : 'Type what is happening.' }}
          </p>
          <textarea class="texte" rows="4" [value]="transcription()" (input)="modifierTexte($event)"
                    placeholder="Your words appear here..."></textarea>
          @if (secondes() !== null) {
            <p class="compte">Sending to the ground doctor automatically in {{ secondes() }} s</p>
          }
          <div class="boutons">
            <button class="envoyer" (click)="envoyer()">SEND NOW</button>
            <button class="annuler" (click)="annuler()">Cancel (false alarm)</button>
          </div>
        }
        @if (etat() === 'envoi') {
          <h1>Sending...</h1>
          <p class="consigne">Contacting the ground doctor.</p>
        }
        @if (etat() === 'erreur') {
          <h1>Not sent yet</h1>
          <p class="consigne">The server is not reachable. Retrying automatically every 5 seconds.</p>
          <p class="texte-lecture">{{ transcription() || 'No description captured.' }}</p>
          <div class="boutons">
            <button class="envoyer" (click)="envoyer()">RETRY NOW</button>
            <button class="annuler" (click)="annuler()">Close without sending</button>
          </div>
        }
        @if (etat() === 'envoye') {
          <h1>Message sent</h1>
          <p class="consigne">The ground doctor was notified at {{ heureEnvoi() }}. Stay calm.</p>
          <p class="texte-lecture">{{ transcription() || 'No description captured.' }}</p>
          <div class="boutons">
            <button class="envoyer" (click)="fermer()">Close</button>
          </div>
        }
      </div>
    }
  `,
  styles: [`
    .commandes { display: flex; flex-direction: column; gap: 8px; }
    .sos { width: 100%; background: var(--rouge); color: white; border: none; border-radius: 12px; padding: 14px 16px; font-size: 16px; font-weight: 700; cursor: pointer; }
    .veille { width: 100%; background: transparent; color: var(--texte-secondaire); border: 1px solid var(--bordure); border-radius: 12px; padding: 10px 12px; font-size: 14px; cursor: pointer; }
    .veille.actif { color: white; border-color: var(--vert); }
    .veille:disabled { opacity: 0.5; cursor: not-allowed; }
    .aide { font-size: 13px; color: var(--texte-secondaire); }
    .aide.erreur { color: var(--orange); }
    .ecran { position: fixed; inset: 0; z-index: 1000; background: #1B0A0A; color: #FFFFFF; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 20px; padding: 32px; text-align: center; }
    h1 { margin: 0; font-size: 48px; letter-spacing: 0.04em; }
    .consigne { margin: 0; font-size: 26px; max-width: 900px; }
    .texte { width: min(900px, 100%); box-sizing: border-box; font-size: 28px; line-height: 1.4; padding: 18px; border-radius: 12px; border: 2px solid #FFFFFF; background: #000000; color: #FFFFFF; resize: none; }
    .texte-lecture { margin: 0; font-size: 26px; max-width: 900px; font-style: italic; }
    .compte { margin: 0; font-size: 22px; color: #FCA5A5; }
    .boutons { display: flex; gap: 20px; flex-wrap: wrap; justify-content: center; }
    .boutons button { min-height: 72px; padding: 0 36px; font-size: 24px; font-weight: 700; border-radius: 14px; cursor: pointer; }
    .envoyer { background: var(--rouge); color: #FFFFFF; border: none; }
    .annuler { background: transparent; color: #FFFFFF; border: 2px solid #FFFFFF; }
  `]
})
export class Urgence implements OnDestroy {
  idAstronaute = input<number>(1);

  private api = inject(ApiService);
  private platformId = inject(PLATFORM_ID);

  etat = signal<EtatUrgence>('inactif');
  transcription = signal('');
  secondes = signal<number | null>(null);
  heureEnvoi = signal('');
  veilleActive = signal(false);
  microActif = signal(false);
  vocalDisponible = signal(false);
  erreurMicro = signal('');

  private Reco: any = null;
  private reconnaissance: any = null;
  private voulu = false;
  private indexDeclencheur = 0;
  private manuel = false;
  private texteAvant = '';
  private minuteur: any = null;
  private relanceReco: any = null;
  private relanceEnvoi: any = null;

  constructor() {
    if (isPlatformBrowser(this.platformId)) {
      const w = window as any;
      this.Reco = w.SpeechRecognition || w.webkitSpeechRecognition || null;
      this.vocalDisponible.set(this.Reco !== null);
    }
  }

  ngOnDestroy() {
    this.arreterReco();
    this.arreterMinuteur();
    clearTimeout(this.relanceEnvoi);
  }

  // --- Voice trigger (listening for the trigger phrase) ---

  basculerVeille() {
    this.erreurMicro.set('');
    if (this.veilleActive()) {
      this.veilleActive.set(false);
      if (this.etat() === 'inactif') {
        this.arreterReco();
      }
      return;
    }
    this.veilleActive.set(true);
    if (this.etat() === 'inactif') {
      this.indexDeclencheur = 0;
      this.manuel = false;
      this.texteAvant = '';
      this.demarrerSession();
    }
  }

  // --- Opening emergency mode ---

  declencherManuellement() {
    this.manuel = true;
    this.indexDeclencheur = 0;
    this.texteAvant = '';
    this.arreterReco();
    this.ouvrirUrgence();
    this.demarrerSession();
  }

  private ouvrirUrgence() {
    this.erreurMicro.set('');
    this.transcription.set('');
    this.etat.set('ecoute');
    this.relancerMinuteur();
  }

  // --- Speech recognition (Web Speech API) ---

  private demarrerSession() {
    if (!this.Reco) {
      return;
    }
    this.arreterReco();
    const r = new this.Reco();
    r.lang = 'en-US';
    r.continuous = true;
    r.interimResults = true;
    r.onstart = () => this.microActif.set(true);
    r.onresult = (e: any) => this.surResultat(e);
    r.onerror = (e: any) => this.surErreur(e);
    r.onend = () => this.surFin();
    this.reconnaissance = r;
    this.voulu = true;
    try {
      r.start();
    } catch {
      this.microActif.set(false);
    }
  }

  private arreterReco() {
    this.voulu = false;
    clearTimeout(this.relanceReco);
    this.microActif.set(false);
    if (this.reconnaissance) {
      this.reconnaissance.onstart = null;
      this.reconnaissance.onresult = null;
      this.reconnaissance.onerror = null;
      this.reconnaissance.onend = null;
      try {
        this.reconnaissance.abort();
      } catch {
        // already stopped
      }
      this.reconnaissance = null;
    }
  }

  private surResultat(e: any) {
    const resultats: string[] = [];
    for (let i = 0; i < e.results.length; i++) {
      resultats.push(e.results[i][0].transcript);
    }

    if (this.etat() === 'inactif') {
      for (let i = e.resultIndex; i < resultats.length; i++) {
        if (positionApresDeclencheur(resultats[i]) >= 0) {
          this.indexDeclencheur = i;
          this.manuel = false;
          this.texteAvant = '';
          this.ouvrirUrgence();
          this.transcription.set(construireTranscription(resultats, i, false));
          this.relancerMinuteur();
          return;
        }
      }
      return;
    }

    if (this.etat() === 'ecoute') {
      const courant = construireTranscription(resultats, this.indexDeclencheur, this.manuel);
      const total = (this.texteAvant + ' ' + courant).trim();
      if (total !== this.transcription()) {
        this.transcription.set(total);
        this.relancerMinuteur();
      }
    }
  }

  private surErreur(e: any) {
    const code = e && e.error;
    if (code === 'not-allowed' || code === 'service-not-allowed') {
      this.erreurMicro.set('Microphone access was denied. Allow it in the browser to use voice.');
      this.veilleActive.set(false);
      this.arreterReco();
    } else if (code === 'network') {
      this.erreurMicro.set('Speech recognition needs an Internet connection in this browser.');
      this.veilleActive.set(false);
      this.arreterReco();
    }
    // "no-speech" and "aborted" are normal: the session simply ends and restarts
  }

  private surFin() {
    this.reconnaissance = null;
    this.microActif.set(false);
    if (!this.voulu) {
      return;
    }
    // The browser ended the session (silence or time limit): restart it
    if (this.etat() === 'ecoute') {
      this.texteAvant = this.transcription();
      this.manuel = true;
    } else {
      this.manuel = false;
      this.texteAvant = '';
    }
    this.indexDeclencheur = 0;
    this.relanceReco = setTimeout(() => {
      if (this.voulu) {
        this.demarrerSession();
      }
    }, 300);
  }

  // --- Typing fallback ---

  modifierTexte(evenement: Event) {
    const valeur = (evenement.target as HTMLTextAreaElement).value;
    this.arreterReco();
    this.transcription.set(valeur);
    this.relancerMinuteur();
  }

  // --- Automatic sending ---

  private relancerMinuteur() {
    this.secondes.set(this.transcription().trim() === '' ? 10 : 5);
    if (this.minuteur === null) {
      this.minuteur = setInterval(() => {
        const reste = (this.secondes() ?? 0) - 1;
        this.secondes.set(reste);
        if (reste <= 0) {
          this.arreterMinuteur();
          this.envoyer();
        }
      }, 1000);
    }
  }

  private arreterMinuteur() {
    if (this.minuteur !== null) {
      clearInterval(this.minuteur);
      this.minuteur = null;
    }
    this.secondes.set(null);
  }

  envoyer() {
    if (this.etat() === 'envoi' || this.etat() === 'envoye' || this.etat() === 'inactif') {
      return;
    }
    clearTimeout(this.relanceEnvoi);
    this.arreterMinuteur();
    this.arreterReco();
    const texte = this.transcription().trim() || TEXTE_PAR_DEFAUT;
    this.etat.set('envoi');

    this.api.envoyerUrgence(this.idAstronaute(), texte).subscribe({
      next: () => {
        this.heureEnvoi.set(new Date().toLocaleTimeString('en-GB'));
        this.etat.set('envoye');
      },
      error: () => {
        this.etat.set('erreur');
        this.relanceEnvoi = setTimeout(() => {
          if (this.etat() === 'erreur') {
            this.envoyer();
          }
        }, 5000);
      }
    });
  }

  annuler() {
    clearTimeout(this.relanceEnvoi);
    this.arreterMinuteur();
    this.arreterReco();
    this.etat.set('inactif');
    this.transcription.set('');
    this.reprendreVeille();
  }

  fermer() {
    this.etat.set('inactif');
    this.transcription.set('');
    this.reprendreVeille();
  }

  private reprendreVeille() {
    if (this.veilleActive()) {
      this.indexDeclencheur = 0;
      this.manuel = false;
      this.texteAvant = '';
      this.demarrerSession();
    }
  }
}

// Exposed for documentation: the phrases that open emergency mode
export const PHRASES_URGENCE = PHRASES_DECLENCHEUR;

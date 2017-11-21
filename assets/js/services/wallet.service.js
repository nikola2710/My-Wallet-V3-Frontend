'use strict';

angular
  .module('walletApp')
  .factory('Wallet', Wallet);

Wallet.$inject = ['$http', '$window', '$timeout', '$location', '$injector', 'Alerts', 'MyWallet', 'MyBlockchainApi', 'MyBlockchainRng', 'MyBlockchainSettings', 'MyWalletStore', 'MyWalletHelpers', '$rootScope', 'AngularHelper', 'ngAudio', 'localStorageService', '$translate', '$filter', '$state', '$q', 'languages', 'currency', 'theme', 'BlockchainConstants', 'Env', 'BrowserHelper'];

function Wallet ($http, $window, $timeout, $location, $injector, Alerts, MyWallet, MyBlockchainApi, MyBlockchainRng, MyBlockchainSettings, MyWalletStore, MyWalletHelpers, $rootScope, AngularHelper, ngAudio, localStorageService, $translate, $filter, $state, $q, languages, currency, theme, BlockchainConstants, Env, BrowserHelper) {
  BrowserHelper.migrateCookiesToLocalStorage();
  const wallet = {
    goal: {
      auth: false,
      upgrade: false
    },
    status: {
      isLoggedIn: false,
      didUpgradeToHd: null,
      didInitializeHD: false,
      didLoadSettings: false,
      didLoadTransactions: false,
      didLoadBalances: false,
      didConfirmRecoveryPhrase: false
    },
    settings: {
      currency: null,
      displayCurrency: null,
      displayTransactionCurrencyAsFiat: null,
      language: null,
      btcCurrency: null,
      needs2FA: null,
      twoFactorMethod: null,
      feePerKB: null,
      handleBitcoinLinks: false,
      blockTOR: null,
      rememberTwoFactor: null,
      secondPassword: null,
      ipWhitelist: null,
      apiAccess: null,
      restrictToWhitelist: null,
      loggingLevel: null
    },
    user: {
      current_ip: null,
      email: null,
      passwordHint: '',
      mobileNumber: null,
      alias: null
    }
  };
  wallet.fiatHistoricalConversionCache = {};
  wallet.conversions = {};
  wallet.paymentRequests = [];
  wallet.my = MyWallet;
  wallet.settings_api = MyBlockchainSettings;
  wallet.store = MyWalletStore;

  wallet.api = MyBlockchainApi;
  wallet.rng = MyBlockchainRng;

  let toggleEnabled = true;
  Env.then(env => {
    wallet.api.ROOT_URL = env.rootURL; // Explorer endpoints
    wallet.api.API_ROOT_URL = env.apiDomain; // API endpoints

    if (languages.isLocalizedMessage(env.webHardFork.balanceMessage)) {
      toggleEnabled = false;
    }

    if (env.customWebSocketURL) {
      wallet.my.ws.wsUrl = env.customWebSocketURL;
    }

    BlockchainConstants.NETWORK = env.network;

    if (env.shapeshift) {
      BlockchainConstants.SHAPE_SHIFT_KEY = env.shapeshift.apiKey;
    }

    if ($window.location.hostname === 'localhost' || !env.isProduction) {
      const KEY = 'qa-tools-enabled';
      env.qaDebugger = localStorageService.get(KEY);
      let reloadWithDebug = (debug) => { localStorageService.set(KEY, debug); $window.location.reload(); };
      $window.enableQA = () => reloadWithDebug(true);
      $window.disableQA = () => reloadWithDebug(false);
    }
  });

  wallet.api_code = '1770d5d9-bcea-4d28-ad21-6cbd5be018a8';
  MyBlockchainApi.API_CODE = wallet.api_code;

  wallet.didLogin = (uid, successCallback) => {
    wallet.status.didUpgradeToHd = wallet.my.wallet.isUpgradedToHD;
    if (wallet.my.wallet.isUpgradedToHD) {
      wallet.status.didConfirmRecoveryPhrase = wallet.my.wallet.hdwallet.isMnemonicVerified;
    } else {
      wallet.goal.firstTime = true;
    }
    wallet.user.uid = uid;
    wallet.settings.secondPassword = wallet.my.wallet.isDoubleEncrypted;
    wallet.settings.pbkdf2 = wallet.my.wallet.pbkdf2_iterations;
    wallet.settings.logoutTimeMinutes = wallet.my.wallet.logoutTime / 60000;
    if (wallet.my.wallet.isUpgradedToHD && !wallet.status.didInitializeHD) {
      wallet.status.didInitializeHD = true;
    }
    $window.name = 'blockchain-' + uid;
    wallet.fetchAccountInfo().then((guid) => {
      currency.fetchAllRates(wallet.settings.currency);
      wallet.initExternal();
      wallet.status.isLoggedIn = true;
      successCallback && successCallback(guid);
    });
  };

  wallet.login = (uid, password, two_factor_code, needsTwoFactorCallback, successCallback, errorCallback, sharedKey) => {
    let needsTwoFactorCode = (method) => {
      Alerts.displayWarning('Please enter your 2FA code');
      wallet.settings.needs2FA = true;
      // 2: Email
      // 3: Yubikey
      // 4: Google Authenticator
      // 5: SMS

      needsTwoFactorCallback(method);

      wallet.settings.twoFactorMethod = method;
      AngularHelper.$safeApply();
    };

    let loginError = (error) => {
      console.log(error);
      if (error.length && error.indexOf('Unknown Wallet Identifier') > -1) {
        errorCallback('uid', 'UNKNOWN_IDENTIFIER');
      } else if (error.length && error.indexOf('password') > -1) {
        errorCallback('password', error);
      } else if ((error.length && error.indexOf('Invalid authentication code') > -1) || (error.length && error.indexOf('Authentication code is incorrect') > -1)) {
        errorCallback('twoFactor', error);
      } else {
        console.log(error);
        Alerts.displayError(error.message || error, true);
        errorCallback();
      }
      AngularHelper.$safeApply();
    };

    if (two_factor_code != null && two_factor_code !== '') {
      wallet.settings.needs2FA = true;
    } else {
      two_factor_code = null;
    }

    let authorizationRequired = () => {
      wallet.goal.auth = true;
      Alerts.displayWarning('CHECK_EMAIL_VERIFY_BROWSER', true);
      AngularHelper.$safeApply();
    };

    var two_factor = null;
    if (wallet.settings.twoFactorMethod) {
      two_factor = {
        type: wallet.settings.twoFactorMethod,
        code: two_factor_code
      };
    }

    const doLogin = (uid, sessionGuid, sessionToken) => {
      if (uid !== sessionGuid) {
        // Don't reuse the session token for a different wallet.
        sessionToken = null;
      }

      // Immedidately store the new guid and session token, in case the user needs
      // to refresh their browser:
      // Safari Incognito will set these values, but won't read them back. So we're
      // also setting wallet.sessionToken and wallet.sessionGuid
      const newSessionToken = (token) => {
        wallet.sessionToken = token;
        wallet.sessionGuid = uid;
        localStorageService.set('session', token);
        localStorageService.set('guid', uid);
      };

      wallet.my.login(
        uid,
        password,
        {
          twoFactor: two_factor,
          sessionToken: sessionToken,
          sharedKey
        },
        {
          newSessionToken: newSessionToken,
          needsTwoFactorCode: needsTwoFactorCode,
          authorizationRequired: authorizationRequired
        }
      )
      .then((result) => {
        wallet.didLogin(uid, successCallback);
      })
      .catch(loginError);
    };

    // Check if we already have a session token:
    // Safari Incognito will not return anything here.
    let sessionToken = localStorageService.get('session') || wallet.sessionToken;
    let sessionGuid = localStorageService.get('guid') || wallet.sessionGuid;

    doLogin(uid, sessionGuid, sessionToken);
  };

  wallet.fetchAccountInfo = () => {
    return $q.resolve(wallet.my.wallet.fetchAccountInfo()).then((result) => {
      const accountInfo = wallet.my.wallet.accountInfo;

      wallet.user.email = accountInfo.email;

      if (wallet.my.wallet.accountInfo.mobile) {
        wallet.user.mobileNumber = accountInfo.mobile;
      } else {
        wallet.user.mobileNumber = '+' + accountInfo.dialCode;
      }
      wallet.user.isEmailVerified = accountInfo.isEmailVerified;
      wallet.user.isMobileVerified = accountInfo.isMobileVerified;

      wallet.settings.currency = $filter('getByProperty')('code', accountInfo.currency, currency.currencies);

      // TODO: handle more of this in My-Wallet-V3
      wallet.settings.ipWhitelist = result.ip_lock || '';
      wallet.settings.restrictToWhitelist = result.ip_lock_on;
      wallet.settings.apiAccess = result.is_api_access_enabled;
      wallet.settings.rememberTwoFactor = !result.never_save_auth_type;
      wallet.settings.needs2FA = result.auth_type !== 0;
      wallet.settings.twoFactorMethod = result.auth_type;
      wallet.settings.loggingLevel = result.logging_level;
      wallet.user.current_ip = result.my_ip;
      wallet.user.guid = result.guid;
      wallet.user.alias = result.alias;
      wallet.settings.notifications_on = result.notifications_on;
      wallet.settings.notifications = {};
      if (result.notifications_type) {
        let notifs = wallet.settings.notifications;
        result.notifications_type.forEach(code => {
          let type = Math.log2(code);
          if (type === 0) notifs.email = true;
          if (type === 2) notifs.http = true;
          if (type === 5) notifs.sms = true;
        });
      }

      wallet.user.passwordHint = result.password_hint1;
      wallet.setLanguage($filter('getByProperty')('code', result.language, languages.languages));
      wallet.settings.btcCurrency = $filter('getByProperty')('serverCode', result.btc_currency, currency.bitCurrencies);
      wallet.settings.displayCurrency = wallet.settings.btcCurrency;
      wallet.settings.displayTransactionCurrencyAsFiat = false;
      wallet.settings.theme = $filter('getByProperty')('name', localStorageService.get('theme'), theme.themes) || theme.themes[0];
      wallet.settings.feePerKB = wallet.my.wallet.fee_per_kb;
      wallet.settings.blockTOR = !!result.block_tor_ips;
      wallet.status.didLoadSettings = true;

      let isUsingThemesExperiment = MyBlockchainApi.createExperiment(0);
      if (wallet.settings.theme === theme.themes[0]) isUsingThemesExperiment.recordA();
      else isUsingThemesExperiment.recordB();

      if (wallet.my.wallet.isUpgradedToHD) {
        let didFetchTransactions = () => {
          if (browserDetection().browser === 'ie') {
            console.warn('Stop!');
            console.warn('This browser feature is intended for developers. If someone told you to copy-paste something here, it is a scam and will give them access to your money!');
          } else {
            console.log('%cStop!', 'color:white; background:red; font-size: 16pt');
            console.log('%cThis browser feature is intended for developers. If someone told you to copy-paste something here, it is a scam and will give them access to your money!', 'font-size: 14pt');
          }
          wallet.status.didLoadTransactions = true;
          wallet.status.didLoadBalances = true;
          $rootScope.showBch = wallet.my.wallet.bch.balance > 0 || wallet.my.wallet.bch.txs.length > 0;
          Ethereum.recordStats();
          AngularHelper.$safeApply();
        };

        let history = [];
        history.push(wallet.my.wallet.getHistory());

        let Ethereum = $injector.get('Ethereum');
        if (Ethereum.eth && Ethereum.userHasAccess) history.push(Ethereum.fetchHistory());

        let ShapeShift = $injector.get('ShapeShift');
        if (ShapeShift.shapeshift) ShapeShift.checkForCompletedTrades();

        history.push(wallet.my.wallet.bch.getHistory());

        $q.all(history).then(didFetchTransactions);
      }

      return result.guid;
    });
  };

  wallet.initExternal = () => {
    let { external } = MyWallet.wallet;
    if (external) {
      let { coinify, sfox, unocoin } = external;
      if (coinify) $injector.get('coinify').init(coinify); // init coinify to monitor incoming coinify payments
      if (unocoin) $injector.get('unocoin').init(unocoin); // init unocoin to monitor incoming payments
      if (sfox) $injector.get('sfox').init(sfox); // init sfox to monitor incoming payments
    }
  };

  wallet.upgrade = (successCallback, cancelSecondPasswordCallback) => {
    let success = () => {
      wallet.status.didUpgradeToHd = true;
      wallet.status.didInitializeHD = true;
      wallet.my.wallet.getHistory().then(() => {
        wallet.status.didLoadBalances = true;
        // Montitored by e.g. acticity feed:
        wallet.status.didLoadTransactions = true;
      });
      successCallback();
      AngularHelper.$safeApply();
    };

    let error = () => {
      wallet.store.enableLogout();
      wallet.store.setIsSynchronizedWithServer(true);
      $window.location.reload();
    };

    let proceed = (password) => {
      $translate('FIRST_ACCOUNT_NAME').then((translation) => {
        wallet.my.wallet.upgradeToV3(translation, password, success, error);
      });
    };
    wallet.askForSecondPasswordIfNeeded()
      .then(proceed).catch(cancelSecondPasswordCallback);
  };

  wallet.legacyAddresses = () => (
    wallet.status.isLoggedIn ? wallet.my.wallet.keys : []
  );

  wallet.getReceiveAddress = MyWalletHelpers.memoize((acctIdx, addrIdx) => {
    let account = wallet.accounts()[acctIdx];
    return account.receiveAddressAtIndex(addrIdx);
  });

  wallet.create = (password, email, currency, language, success_callback) => {
    let success = (uid, sharedKey, password, sessionToken) => {
      wallet.sessionToken = sessionToken;
      wallet.sessionGuid = uid;
      localStorageService.set('session', sessionToken);
      localStorageService.set('guid', uid);
      Alerts.displaySuccess('Wallet created with identifier: ' + uid);
      wallet.goal.firstTime = true;

      let loginSuccess = (guid) => {
        success_callback(uid);
      };

      let loginError = (error) => {
        console.log(error);
        Alerts.displayError('Unable to login to new wallet');
      };

      wallet.login(uid, password, null, null, loginSuccess, loginError);
    };

    let error = (error) => {
      if (error.message !== void 0) Alerts.displayError(error.message);
      else Alerts.displayError(error);
    };

    let currency_code = currency && currency.code || 'USD';
    let language_code = language && language.code || 'en';

    $translate('FIRST_ACCOUNT_NAME')
      .then((translation) => {
        wallet.my.createNewWallet(
          email,
          password,
          translation,
          language_code,
          currency_code,
          success,
          error
        );
      });
  };

  wallet.askForMainPassword = () => {
    let defer = $q.defer();
    $rootScope.$broadcast('requireMainPassword', defer);
    return defer.promise;
  };

  wallet.askForSecondPasswordIfNeeded = () => {
    let defer = $q.defer();
    if (wallet.my.wallet.isDoubleEncrypted) {
      $rootScope.$broadcast('requireSecondPassword', defer);
    } else {
      defer.resolve(null);
    }
    return defer.promise;
  };

  wallet.saveActivity = () => {
    // TYPES: ['transactions', 'security', 'settings', 'accounts']
    $rootScope.$broadcast('updateActivityFeed');
  };

  let addressBook = void 0;
  wallet.addressBook = (refresh) => {
    let myAddressBook = wallet.my.wallet.addressBook;
    if (addressBook === void 0 || refresh) {
      addressBook = Object.keys(myAddressBook).map((key) => {
        return {
          address: key,
          label: myAddressBook[key]
        };
      });
    }
    return addressBook;
  };

  wallet.removeAddressBookEntry = (address) => {
    wallet.my.wallet.removeAddressBookEntry(address.address);
    wallet.addressBook(true); // Refreshes address book
  };

  wallet.createAccount = (label, successCallback, errorCallback, cancelCallback) => {
    let proceed = (password) => {
      wallet.my.wallet.newAccount(label, password);
      wallet.my.wallet.getHistory();
      successCallback && successCallback();
    };
    wallet.askForSecondPasswordIfNeeded()
      .then(proceed).catch(cancelCallback);
  };

  wallet.renameAccount = (account, name, successCallback, errorCallback) => {
    account.label = name;
    successCallback();
  };

  wallet.changeLegacyAddressLabel = (address, label, successCallback, errorCallback) => {
    address.label = label;
    successCallback();
  };

  wallet.askForDeauth = () => (
    wallet.user.isEmailVerified && !wallet.autoLogout
  );

  wallet.logout = (options = {}) => {
    let { auto = false } = options;
    wallet.autoLogout = auto;
    $window.name = wallet.askForDeauth() ? 'blockchain-logout' : 'blockchain';
    localStorageService.remove('password');
    wallet.my.logout(true);
  };

  wallet.makePairingCode = (successCallback, errorCallback) => {
    let success = (code) => {
      successCallback(code);
      AngularHelper.$safeApply();
    };

    let error = () => {
      errorCallback();
      AngularHelper.$safeApply();
    };

    wallet.my.makePairingCode(success, error);
  };

  wallet.confirmRecoveryPhrase = () => {
    wallet.my.wallet.hdwallet.verifyMnemonic();
    wallet.status.didConfirmRecoveryPhrase = true;
  };

  wallet.isCorrectMainPassword = (candidate) =>
    wallet.store.isCorrectMainPassword(candidate);

  wallet.changePassword = (newPassword, successCallback, errorCallback) => {
    wallet.store.changePassword(newPassword, () => {
      let msg = 'CHANGE_PASSWORD_SUCCESS';
      Alerts.displaySuccess(msg);
      successCallback(msg);
    }, () => {
      let err = 'CHANGE_PASSWORD_FAILED';
      Alerts.displayError(err);
      errorCallback(err);
    });
  };

  wallet.setIPWhitelist = (ips) => {
    let update = (s, e) => wallet.settings_api.updateIPlock(ips, s, e);
    return $q(update).then(() => wallet.settings.ipWhitelist = ips);
  };

  wallet.resendEmailConfirmation = (successCallback, errorCallback) => {
    let success = () => {
      successCallback && successCallback();
      AngularHelper.$safeApply();
    };

    let error = () => {
      errorCallback && errorCallback();
      AngularHelper.$safeApply();
    };

    wallet.settings_api.resendEmailConfirmation(wallet.user.email, success, error);
  };

  wallet.sendConfirmationCode = (successCallback, errorCallback) => {
    let success = () => {
      successCallback && successCallback();
      AngularHelper.$safeApply();
    };
    let error = () => {
      errorCallback && errorCallback();
      AngularHelper.$safeApply();
    };
    wallet.settings_api.sendConfirmationCode(success, error);
  };

  wallet.verifyEmail = (code, successCallback, errorCallback) => {
    let success = (res) => {
      if (res.success) {
        wallet.user.isEmailVerified = 1;
        AngularHelper.$safeApply();
        successCallback();
      } else {
        error(res.error);
      }
    };

    let error = (err) => {
      errorCallback(err);
      AngularHelper.$safeApply();
    };

    wallet.settings_api.verifyEmail(code, success, error);
  };

  wallet.setPbkdf2Iterations = (n, successCallback, errorCallback, cancelCallback) => {
    let proceed = (password) => {
      wallet.my.wallet.changePbkdf2Iterations(parseInt(n, 10), password);
      wallet.settings.pbkdf2 = wallet.my.wallet.pbkdf2_iterations;
      successCallback();
    };
    wallet.askForSecondPasswordIfNeeded()
      .then(proceed).catch(cancelCallback);
  };
  wallet.setLoggingLevel = (level) => {
    wallet.settings_api.updateLoggingLevel(level, () => {
      wallet.settings.loggingLevel = level;
      wallet.saveActivity(4);
      AngularHelper.$safeApply();
    }, () => {
      Alerts.displayError('Failed to update logging level');
      AngularHelper.$safeApply();
    });
  };

  wallet.toggleDisplayCurrency = () => {
    if (!toggleEnabled) return;
    if (currency.isBitCurrency(wallet.settings.displayCurrency)) {
      wallet.settings.displayCurrency = wallet.settings.currency;
    } else {
      wallet.settings.displayCurrency = wallet.settings.btcCurrency;
    }
  };

  wallet.checkAndGetTransactionAmount = (amount, currency, success, error) => {
    amount = currency.convertToSatoshi(amount, currency);
    if (success == null || error == null) {
      console.error('Success and error callbacks are required');
      return;
    }
    return amount;
  };

  wallet.addAddressOrPrivateKey = (addressOrPrivateKey, needsBipPassphraseCallback, successCallback, errorCallback, cancel) => {
    let success = (address) => {
      successCallback(address);
      AngularHelper.$safeApply();
    };

    let proceed = (secondPassword = '') => {
      let error = (message) => {
        if (message === 'needsBip38') {
          needsBipPassphraseCallback(proceedWithBip38);
        } else {
          errorCallback(message);
        }
        AngularHelper.$safeApply();
      };

      let proceedWithBip38 = (bipPassphrase) => {
        wallet.my.wallet.importLegacyAddress(addressOrPrivateKey, '', secondPassword, bipPassphrase).then(success, error);
      };

      let proceedWithoutBip38 = () => {
        wallet.my.wallet.importLegacyAddress(addressOrPrivateKey, '', secondPassword, '').then(success, error);
      };
      proceedWithoutBip38();
    };

    wallet.askForSecondPasswordIfNeeded()
      .then(proceed, cancel);
  };

  wallet.getAddressBookLabel = (address) =>
    wallet.my.wallet.getAddressBookLabel(address);

  wallet.getMnemonic = (successCallback, errorCallback, cancelCallback) => {
    let proceed = (password) => {
      let mnemonic = wallet.my.wallet.getMnemonic(password);
      successCallback(mnemonic);
    };
    wallet.askForSecondPasswordIfNeeded()
      .then(proceed).catch(cancelCallback);
  };

  wallet.importWithMnemonic = (mnemonic, bip39pass, successCallback, errorCallback, cancelCallback) => {
    let cancel = () => {
      cancelCallback();
    };

    let restore = (password) => {
      console.log('restoring...');
      wallet.my.wallet.restoreHDWallet(mnemonic, bip39pass, password);
    };

    let update = () => {
      console.log('updating...');
      wallet.my.wallet.getHistory().then(successCallback);
    };

    wallet.askForSecondPasswordIfNeeded()
      .then(restore).then(update).catch(cancel);
  };

  wallet.getDefaultAccountIndex = () => {
    if (wallet.my.wallet == null) {
      return 0;
    } else if (wallet.my.wallet.isUpgradedToHD) {
      return wallet.my.wallet.hdwallet.defaultAccountIndex;
    } else {
      return 0;
    }
  };

  wallet.getReceivingAddressForAccount = (idx) => {
    if (wallet.my.wallet.isUpgradedToHD) {
      return wallet.my.wallet.hdwallet.accounts[idx].receiveAddress;
    } else {
      return '';
    }
  };

  wallet.getReceivingAddressIndexForAccount = (idx) => {
    if (wallet.my.wallet.isUpgradedToHD) {
      return wallet.my.wallet.hdwallet.accounts[idx].receiveIndex;
    } else {
      return null;
    }
  };

  wallet.parsePaymentRequest = (url) => {
    let result = {
      address: null,
      amount: null,
      label: null,
      message: null
    };
    result.isValid = true;
    if (url.indexOf('bitcoin:') === 0) {
      let withoutPrefix = url.replace('bitcoin://', '').replace('bitcoin:', '');
      let qIndex = withoutPrefix.indexOf('?');
      if (qIndex !== -1) {
        result.address = withoutPrefix.substr(0, qIndex);
        let keys = withoutPrefix.substr(qIndex + 1).split('&');
        keys.forEach((item) => {
          var key, value;
          key = item.split('=')[0];
          value = item.split('=')[1];
          if (key === 'amount') {
            result.amount = currency.convertToSatoshi(parseFloat(value), currency.bitCurrencies[0]);
          } else if (result[key] !== void 0) {
            result[key] = value;
          }
        });
      } else {
        result.address = withoutPrefix;
      }
    } else if (wallet.isValidAddress(url)) {
      result.address = url;
    } else {
      result.isValid = false;
    }
    return result;
  };

  wallet.parseBitcoinURL = (destinations) => {
    if (destinations.length === 0) return;
    function extractFromUri (URI) {
      let result = {};
      const addressRegex = /(?=\:)(.*)(?=\?)/;
      const amountRegex = /amount=[0-9.]*/;
      const noteRegex = /message=.*/;
      const addressSlice = 1;
      const amountSlice = 7;
      const noteSlice = 8;
      const address = URI.match(addressRegex)[0];
      result['address'] = address.slice(addressSlice, address.length);
      const amount = URI.match(amountRegex);
      amount ? result['amount'] = parseFloat(amount[0].slice(amountSlice, amount[0].length)) * 100000000 : '';
      const note = URI.match(noteRegex);
      note ? result['note'] = decodeURI(note[0].slice(noteSlice, note[0].length)) : '';
      return result;
    }
    return extractFromUri(destinations[0].address);
  };

  wallet.isSynchronizedWithServer = () =>
    wallet.store.isSynchronizedWithServer();

  $window.onbeforeunload = (event) => {
    if (!wallet.isSynchronizedWithServer() && wallet.my.wallet.isEncryptionConsistent) {
      event.preventDefault();
      return 'There are unsaved changes. Are you sure?';
    }

    if (wallet.askForDeauth()) {
      $window.name = 'blockchain-logout';
    }

    if ($rootScope.inMobileBuy) {
      $state.go('intermediate');
    }
    // TODO: fix autoreload dev feature
    // if ($rootScope.autoReload) {
    //   localStorageService.set('reload.url', $location.url())
    // }
  };

  wallet.isValidAddress = (address) => MyWalletHelpers.isBitcoinAddress(address);
  wallet.isValidPrivateKey = (priv) => MyWalletHelpers.isValidPrivateKey(priv);

  wallet.archive = (address_or_account) => {
    wallet.saveActivity(3);
    address_or_account.archived = true;
    address_or_account.active = false;
  };

  wallet.unarchive = (address_or_account) => {
    wallet.saveActivity(3);
    address_or_account.archived = false;
    address_or_account.active = true;
  };

  wallet.deleteLegacyAddress = (address) => {
    wallet.saveActivity(3);
    wallet.my.wallet.deleteLegacyAddress(address);
  };

  wallet.accounts = () => {
    if (!wallet.status.isLoggedIn) return null;
    if (wallet.my.wallet.hdwallet != null) {
      return wallet.my.wallet.hdwallet.accounts;
    } else {
      return [];
    }
  };

  wallet.total = (accountIndex) => {
    if (wallet.my.wallet == null || !wallet.status.isLoggedIn) return null;
    switch (accountIndex) {
      case '':
      case void 0:
        if (wallet.my.wallet.isUpgradedToHD) {
          if (wallet.my.wallet.balanceActiveLegacy == null || wallet.my.wallet.hdwallet.balanceActiveAccounts == null) return null;
          return wallet.my.wallet.hdwallet.balanceActiveAccounts + wallet.my.wallet.balanceActiveLegacy;
        } else {
          return wallet.my.wallet.balanceActiveLegacy;
        }
        break;
      case 'imported':
        return wallet.my.wallet.balanceActiveLegacy;
      default:
        let account = wallet.accounts()[parseInt(accountIndex, 10)];
        return account == null ? null : account.balance;
    }
  };

  wallet.formatTransactionCoins = (tx) => {
    let input = tx.processedInputs
      .filter(i => !i.change)[0] || tx.processedInputs[0];
    let outputs = tx.processedOutputs
      .filter(o => !o.change);

    let setLabel = (io) => (
      io.label = io.label || wallet.getAddressBookLabel(io.address) || io.address
    );

    setLabel(input);
    outputs.forEach(setLabel);

    return { input: input, outputs: outputs };
  };

  wallet.beep = () => {
    try {
      let sound = ngAudio.load('beep.wav');
      sound.play();
    } catch (e) {
      console.error(e);
    }
  };

  wallet.monitor = (event, data) => {
    if (event === 'on_tx') {
      $rootScope.cancelRefresh();
      let tx = wallet.my.wallet.txList.transactions()[0];
      if (tx.result > 0 && tx.txType === 'received') {
        wallet.beep();
        Alerts.displayReceivedBitcoin('JUST_RECEIVED_BITCOIN');
      }
    } else if (event === 'on_block') {
    } else if (event === 'error_restoring_wallet') {
    } else if (event === 'did_set_guid') {
    } else if (event === 'on_wallet_decrypt_finish') {
    } else if (event === 'hd_wallets_does_not_exist') {
      wallet.status.didUpgradeToHd = false;
      wallet.goal.upgrade = true;
    } else if (event === 'wallet not found') {
      Alerts.displayError('WALLET_NOT_FOUND');
    } else if (event === 'ticker_updated' || event === 'did_set_latest_block') {
    } else if (event === 'logging_out') {
      if (wallet.autoLogout) {
        $translate('LOGGED_OUT_AUTOMATICALLY').then((translation) => {
          localStorageService.set('alert-warning', translation);
        });
      }
      wallet.status.isLoggedIn = false;
      while (wallet.paymentRequests.length > 0) {
        wallet.paymentRequests.pop();
      }
      wallet.user.uid = '';
      wallet.password = '';
    } else if (event === 'ws_on_close' || event === 'ws_on_open') {
    } else if (event.type !== void 0) {
      if (event.type === 'error') {
        Alerts.displayError(event.msg);
      } else if (event.type === 'success') {
        Alerts.displaySuccess(event.msg);
      } else if (event.type === 'notice') {
        Alerts.displayWarning(event.msg);
      } else {
      }
    } else if (event === 'on_email_verified') {
      if (data.email === wallet.user.email && data.verified) {
        wallet.user.isEmailVerified = 1;
        Alerts.displaySuccess('EMAIL_VERIFIED_MSG');
      }
    } else if (event === 'wallet_logout') {
      if (data.guid === wallet.user.uid) {
        wallet.logout({ auto: true });
      }
    } else if (event === 'on_change') {
      wallet.fetchAccountInfo(wallet.initExternal);
    } else {
    }
    AngularHelper.$safeApply();
  };

  wallet.store.addEventListener((event, data) => {
    wallet.monitor(event, data);
  });

  let message = localStorageService.get('alert-warning');
  if (message !== void 0 && message !== null) {
    Alerts.displayWarning(message, true);
    localStorageService.remove('alert-warning');
  }
  message = localStorageService.get('alert-success');
  if (message !== void 0 && message !== null) {
    Alerts.displaySuccess(message);
    localStorageService.remove('alert-success');
  }

  wallet.setNote = (tx, text) => {
    wallet.my.wallet.setNote(tx.hash, text);
    AngularHelper.$safeApply();
  };

  wallet.deleteNote = (tx) => {
    wallet.my.wallet.deleteNote(tx.hash);
  };

  wallet.getNote = (hash) => {
    return wallet.my.wallet.getNote(hash);
  };

  wallet.setLogoutTime = (minutes, success, error) => {
    wallet.store.setLogoutTime(minutes * 60000);
    wallet.settings.logoutTimeMinutes = minutes;
    success();
  };

  wallet.getCurrency = () => wallet.my.getCurrency();

  wallet.setLanguage = (language) => {
    languages.set(language.code);
    wallet.settings.language = language;
  };

  wallet.changeLanguage = (language) => $q((resolve, reject) => {
    wallet.settings_api.changeLanguage(language.code, () => {
      wallet.setLanguage(language);
      resolve(true);
    }, reject);
  });

  wallet.changeTheme = (theme) => $q((resolve, reject) => {
    localStorageService.set('theme', theme.name);
    resolve(true);
  });

  wallet.changeCurrency = (curr) => $q((resolve, reject) => {
    wallet.settings_api.changeLocalCurrency(curr.code, () => {
      wallet.settings.currency = curr;
      currency.fetchAllRates(curr);
      if (!currency.isBitCurrency(wallet.settings.displayCurrency)) {
        wallet.settings.displayCurrency = curr;
      }
      resolve(true);
    }, reject);
  });

  wallet.changeBTCCurrency = (btcCurrency) => $q((resolve, reject) => {
    wallet.settings_api.changeBtcCurrency(btcCurrency.serverCode, () => {
      wallet.settings.btcCurrency = btcCurrency;
      if (currency.isBitCurrency(wallet.settings.displayCurrency)) {
        wallet.settings.displayCurrency = btcCurrency;
      }
      resolve(true);
    }, reject);
  });

  wallet.changeEmail = (email, successCallback, errorCallback) => {
    wallet.settings_api.changeEmail(email, () => {
      wallet.user.email = email;
      wallet.user.isEmailVerified = 0;
      successCallback();
      AngularHelper.$safeApply();
    }, () => {
      Alerts.displayError('CHANGE_EMAIL_FAILED');
      AngularHelper.$safeApply();
      errorCallback();
    });
  };

  wallet.updateNotificationsType = (types) => $q.resolve(
    MyBlockchainSettings.updateNotificationsType(types).catch(() => {
      Alerts.displayError('UPDATE_NOTIF_FAIL');
    })
  );

  wallet.updateNotificationsOn = (on) => $q.resolve(
    MyBlockchainSettings.updateNotificationsOn(on)
  );

  wallet.setFeePerKB = (fee, successCallback, errorCallback) => {
    wallet.my.wallet.fee_per_kb = fee;
    wallet.settings.feePerKB = fee;
    successCallback();
  };

  wallet.getActivityLogs = (success) => {
    wallet.settings_api.getActivityLogs(success, () => {
      console.log('Failed to load activity logs');
    });
  };

  wallet.isEmailVerified = () => wallet.my.isEmailVerified;

  wallet.changeMobile = (mobile, successCallback, errorCallback) => {
    wallet.settings_api.changeMobileNumber(mobile, () => {
      wallet.user.mobileNumber = mobile;
      wallet.user.isMobileVerified = false;
      successCallback();
      AngularHelper.$safeApply();
    }, () => {
      Alerts.displayError('CHANGE_MOBILE_FAILED');
      errorCallback();
      AngularHelper.$safeApply();
    });
  };

  wallet.verifyMobile = (code, successCallback, errorCallback) => {
    wallet.settings_api.verifyMobile(code, () => {
      wallet.user.isMobileVerified = true;
      successCallback();
      AngularHelper.$safeApply();
    }, () => {
      $translate('VERIFY_MOBILE_FAILED').then((translation) => {
        errorCallback(translation);
      });
      AngularHelper.$safeApply();
    });
  };

  wallet.changePasswordHint = (hint, successCallback, errorCallback) => {
    wallet.settings_api.updatePasswordHint1(hint, () => {
      wallet.user.passwordHint = hint;
      successCallback();
      AngularHelper.$safeApply();
    }, (err) => {
      errorCallback(err);
      AngularHelper.$safeApply();
    });
  };

  wallet.isMobileVerified = () => wallet.my.isMobileVerified;

  wallet.disableSecondFactor = () => {
    wallet.settings_api.unsetTwoFactor(() => {
      wallet.settings.needs2FA = false;
      wallet.settings.twoFactorMethod = null;
      AngularHelper.$safeApply();
    }, () => {
      console.log('Failed');
      AngularHelper.$safeApply();
    });
  };

  wallet.setTwoFactorSMS = () => {
    wallet.settings_api.setTwoFactorSMS(() => {
      wallet.settings.needs2FA = true;
      wallet.settings.twoFactorMethod = 5;
      AngularHelper.$safeApply();
    }, () => {
      console.log('Failed');
      AngularHelper.$safeApply();
    });
  };

  wallet.setTwoFactorEmail = () => {
    wallet.settings_api.setTwoFactorEmail(() => {
      wallet.settings.needs2FA = true;
      wallet.settings.twoFactorMethod = 2;
      AngularHelper.$safeApply();
    }, () => {
      console.log('Failed');
      AngularHelper.$safeApply();
    });
  };

  wallet.setTwoFactorYubiKey = (code, successCallback, errorCallback) => {
    wallet.settings_api.setTwoFactorYubiKey(code, () => {
      wallet.settings.needs2FA = true;
      wallet.settings.twoFactorMethod = 1;
      successCallback();
      AngularHelper.$safeApply();
    }, (error) => {
      console.log(error);
      errorCallback(error);
      AngularHelper.$safeApply();
    });
  };

  wallet.setTwoFactorGoogleAuthenticator = () => {
    wallet.settings_api.setTwoFactorGoogleAuthenticator((secret) => {
      wallet.settings.googleAuthenticatorSecret = secret;
      AngularHelper.$safeApply();
    }, () => {
      console.log('Failed');
      AngularHelper.$safeApply();
    });
  };

  wallet.confirmTwoFactorGoogleAuthenticator = (code, successCallback, errorCallback) => {
    wallet.settings_api.confirmTwoFactorGoogleAuthenticator(code, () => {
      wallet.settings.needs2FA = true;
      wallet.settings.twoFactorMethod = 4;
      wallet.settings.googleAuthenticatorSecret = null;
      successCallback();
      AngularHelper.$safeApply();
    }, () => {
      errorCallback();
      AngularHelper.$safeApply();
    });
  };

  wallet.enableRememberTwoFactor = (successCallback, errorCallback) => {
    let success = () => {
      wallet.settings.rememberTwoFactor = true;
      successCallback();
      AngularHelper.$safeApply();
    };
    let error = () => {
      errorCallback();
      AngularHelper.$safeApply();
    };
    wallet.settings_api.toggleSave2FA(false, success, error);
  };

  wallet.disableRememberTwoFactor = (successCallback, errorCallback) => {
    let success = () => {
      wallet.settings.rememberTwoFactor = false;
      // This takes effect immedidately:
      wallet.sessionToken = undefined;
      localStorageService.remove('session');
      successCallback();
      AngularHelper.$safeApply();
    };
    let error = () => {
      errorCallback();
      AngularHelper.$safeApply();
    };
    wallet.settings_api.toggleSave2FA(true, success, error);
  };

  wallet.handleBitcoinLinks = () => Env.then(env => {
    let uri = env.rootPath + '/open/%s';
    $window.navigator.registerProtocolHandler('bitcoin', uri, 'Blockchain');
  });

  wallet.enableBlockTOR = () => {
    wallet.settings_api.updateTorIpBlock(1, () => {
      wallet.settings.blockTOR = true;
      AngularHelper.$safeApply();
    }, () => {
      console.log('Failed');
      AngularHelper.$safeApply();
    });
  };

  wallet.disableBlockTOR = () => {
    wallet.settings_api.updateTorIpBlock(0, () => {
      wallet.settings.blockTOR = false;
      AngularHelper.$safeApply();
    }, () => {
      console.log('Failed');
      AngularHelper.$safeApply();
    });
  };

  wallet.enableRestrictToWhiteListedIPs = () => {
    wallet.settings_api.updateIPlockOn(true, () => {
      wallet.settings.restrictToWhitelist = true;
      wallet.saveActivity(2);
      AngularHelper.$safeApply();
    }, () => {
      Alerts.displayError('ERR_ENABLE_IP_RESTRICT');
      AngularHelper.$safeApply();
    });
  };

  wallet.disableRestrictToWhiteListedIPs = () => $q((resolve, reject) => {
    wallet.settings_api.updateIPlockOn(false, () => {
      wallet.settings.restrictToWhitelist = false;
      resolve();
    }, () => {
      reject();
    });
  });

  wallet.removeAlias = () => {
    return $q.resolve(wallet.settings_api.removeAlias()).then(
      () => wallet.user.alias = null,
      () => Alerts.displayError('POOR_CONNECTION'));
  };

  wallet.getDefaultAccount = () => (
    wallet.accounts()[wallet.getDefaultAccountIndex()]
  );

  wallet.setDefaultAccount = (account) => {
    wallet.my.wallet.hdwallet.defaultAccountIndex = account.index;
  };

  wallet.isDefaultAccount = (account) =>
    wallet.my.wallet.hdwallet.defaultAccountIndex === account.index;

  wallet.isValidBIP39Mnemonic = (mnemonic) =>
    MyWalletHelpers.isValidBIP39Mnemonic(mnemonic);

  wallet.removeSecondPassword = (password, successCallback, errorCallback) => {
    let success = () => {
      wallet.settings.secondPassword = false;
      successCallback();
      AngularHelper.$safeApply();
    };
    let error = () => {
      errorCallback();
      AngularHelper.$safeApply();
    };
    let decrypting = () => {
      console.log('Decrypting...');
    };
    let syncing = () => {
      console.log('Syncing...');
    };

    const didDecrypt = () => {
      // Check which metadata service features we use:

      // This falls back to cookies if 2nd password is enabled:
      let lastViewed = localStorageService.get('whatsNewViewed');

      if (lastViewed) {
        let whatsNew = wallet.my.wallet.metadata(2);
        whatsNew.fetch()
          .then(() => whatsNew.update({ lastViewed }))
          .then(success);
      }
    };

    wallet.my.wallet.decrypt(password, didDecrypt, error, decrypting, syncing);
  };

  wallet.validateSecondPassword = (password) =>
    wallet.my.wallet.validateSecondPassword(password);

  wallet.setSecondPassword = (password, successCallback) => {
    let success = () => {
      Alerts.displaySuccess('Second password set.');
      wallet.settings.secondPassword = true;
      successCallback();
      AngularHelper.$safeApply();
    };
    let error = () => {
      Alerts.displayError('Second password cannot be set. Contact support.');
      AngularHelper.$safeApply();
    };
    let encrypting = () => {
      console.log('Encrypting...');
    };
    let syncing = () => {
      console.log('Syncing...');
    };

    const proceed = () => {
      wallet.my.wallet.encrypt(password, success, error, encrypting, syncing);
    };

    // whatsNew
    // This falls back to cookies if 2nd password is enabled:
    // let whatsNew = new MyWalletMetadata(2);
    let whatsNew = wallet.my.wallet.metadata(2);
    whatsNew.fetch().then((res) => {
      if (res !== null) {
        localStorageService.set('whatsNewViewed', res.lastViewed);
      }
    }).catch(() => {
      throw new Error("saving your What's New view status failed");
    });

    let other = $q.resolve(); // $q.reject('it can't be combined with feature X');

    $q.all([whatsNew, other]).then(proceed).catch((reason) => {
      console.log('all');
      Alerts.displayError('Could enable second password, because ' + reason);
    });
  };

  // Testing: only works on mock MyWallet

  wallet.refresh = () => {
    wallet.my.refresh();
  };

  wallet.isMock = wallet.my.mockShouldFailToSend !== void 0;
  return wallet;
}

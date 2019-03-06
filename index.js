/* jshint asi: true, esversion: 6, node: true, laxbreak: true, laxcomma: true, undef: true, unused: true */

const APCaccess  = require('apcaccess')
    , NodeCache  = require('node-cache')
    , debug      = require('debug')('apcupsd')
    , inherits   = require('util').inherits
    , moment     = require('moment')
    , underscore = require('underscore')


module.exports = function (homebridge) {
  const Characteristic = homebridge.hap.Characteristic
      , Service = homebridge.hap.Service
      , CommunityTypes = require('hap-nodejs-community-types')(homebridge)

  homebridge.registerAccessory("homebridge-accessory-apcupsd", "apcupsd", APC)

  function APC(log, config) {
    if (!(this instanceof APC)) return new APC(log, config)

    this.log = log
    this.config = config || { accessory: 'apcupsd' }

    this.name = this.config.name
    this.options = underscore.defaults(this.config.options || {}, { ttl: 600, verboseP: false })
    if (this.options.ttl < 10) this.options.ttl = 600
    debug('options', this.options)

    this.location = require('url').parse('http://' + this.config.location + '/')
    if (!this.location.port) {
      this.location.port = 3551
      this.location.host += ':' + this.location.port
    }
    this.cache = new NodeCache({ stdTTL: 1 })
    

    const now = moment().unix()

    this.doorExtra =
    { timesOpened: 0
    , openDuration: 0
    , closedDuration: 0
    , lastActivation: 0
    , lastReset: now - moment('2001-01-01T00:00:00Z').unix()
    , lastChange: now
    , lastStatus: -1
    }

    this.statusFault = Characteristic.StatusFault.NO_FAULT
    this.callbacks = []
  }

  APC.PowerService = function (displayName, subtype) {
    Service.call(this, displayName, '00000001-0000-1000-8000-135D67EC4377', subtype)
    this.addCharacteristic(CommunityTypes.InputVoltageAC)
    this.addCharacteristic(CommunityTypes.BatteryVoltageDC)
    this.addCharacteristic(CommunityTypes.UPSLoadPercent)
    this.addOptionalCharacteristic(CommunityTypes.Watts)
    this.addOptionalCharacteristic(CommunityTypes.OutputVoltageAC)
    this.addOptionalCharacteristic(Characteristic.CurrentTemperature)
  }
  inherits(APC.PowerService, Service)

/* getStatusJson().then(status)

{ "UPSNAME": "alarmpi"                         // UPS name from EEPROM or configuration
, "MODEL": "Back-UPS ES 700G"                  // UPS model derived from UPS information
, "LINEV": "232.0 Volts"                       // Current input line voltage
, "LOADPCT": "5.0 Percent"                     // Percentage of UPS load capacity used
, "BCHARGE": "100.0 Percent"                   // Current battery capacity charge percentage
, "OUTPUTV": "219.7 Volts"                     // Current UPS output voltage
, "ITEMP": "31.5 C"                            //
, "BATTV": "13.5 Volts"                        // Current battery voltage
, "STATFLAG": "0x05000008"                     // UPS status flag in hex
                                               // 0x08: on line
                                               // 0x10: on battery
                                               // 0x20: overloaded output
                                               // 0x40: battery low
                                               // 0x80: replace battery
, "SERIALNO": "5B1325T16968"                   // UPS serial number
, "FIRMWARE": "871.O2 .I USB FW:O2"            // UPS firmware version
, "NOMPOWER": "1500 Watts"                     // Nominal power
, ...
}
 */

  APC.prototype =
  { fetchStatus:
    function (callback) {
      const self = this

      if (!callback) callback = () => {}
      self.cache.get('status', (err, status) => {
        if (err || status) return callback(err, status)

        self._fetchStatus((err, result) => {
          const i = (value) => {
            const integer = value && parseInt(value)

            if (!isNaN(integer)) return integer
          }

          const p = (value) => {
            const percentage = value && parseFloat(value.split(' ')[0])

            if ((!isNaN(percentage)) && (0 <= percentage) && (percentage <= 100)) return percentage
          }

          const r = (value) => {
            const real = value && parseFloat(value.split(' ')[0])

            if (!isNaN(real)) return real
          }

          const s = (value) => {
            return value.split('/').join(' ')
          }

          const t = (value) => {
            return s(value.split('.')[0])
          }
          
          const z =
          { BATTV    : r
          , BCHARGE  : p
          , FIRMWARE : t
          , ITEMP    : r
          , LINEV    : r
          , LOADPCT  : p
          , MODEL    : s
          , NOMPOWER : r
          , OUTPUTV  : r
          , STATFLAG : i
          , SERIALNO : s
          , UPSNAME  : s
          }

          self.statusFault = (err || (!result)) ? Characteristic.StatusFault.GENERAL_FAULT : Characteristic.StatusFault.NO_FAULT
          err = null

          const status = {}
          for (let key in z) {
            let value = result && result[key] && result[key].trim()

            if ((!z.hasOwnProperty(key)) || (value === undefined)) continue

            value = z[key](value)
            if (value !== undefined) status[key] = value
          }

          debug('status', { location: self.location.host, status })

          if (!self.initP) {
            debug('fetchStatus', { location: self.location.host, status: 'initialized' })
            self.initP = true

            if (status.NOMPOWER) {
              self.myPowerService
                .getCharacteristic(CommunityTypes.Watts).on('get', self.getWatts.bind(self))
            }
            if (status.OUTPUTV) {
              self.myPowerService
                .getCharacteristic(CommunityTypes.OutputVoltageAC).on('get', self.getOutputVoltageAC.bind(self))
            }
            if (status.ITEMP) {
              self.myPowerService
                .getCharacteristic(Characteristic.CurrentTemperature).on('get', self.getCurrentTemperature.bind(self))
            }
          }

/*
          if ((status.NOMPOWER !== undefined) && (status.LOADPCT !== undefined)) {
            const power = (status.NOMPOWER * status.LOADPCT) / 100.0

            self.energyHistory.addEntry({ time: moment().unix(), power })
          }
 */
          if (status.STATFLAG !== undefined) {
            const contact = Characteristic.ContactSensorState[(status.STATFLAG & 0x08) ? 'CONTACT_DETECTED'
                                                                                       : 'CONTACT_NOT_DETECTED']
            const now = moment().unix()

            self.doorHistory.addEntry({ time: now, status: contact })

            if (self.doorExtra.lastStatus !== contact) {
              const delta = now - self.doorExtra.lastChange

              self.doorExtra.lastStatus = contact
              if (contact == Characteristic.ContactSensorState.CONTACT_NOT_DETECTED) {
                self.doorExtra.timesOpened++
                self.doorExtra.closedDuration += delta
                self.doorExtra.lastActivation = now - self.doorHistory.getInitialTime()
              } else {
                self.doorExtra.openDuration += delta
              }
              self.doorExtra.lastChange = now
              self.doorHistory.setExtraPersistedData(self.doorExtra)
              debug('fetchStatus', { location: self.location.host, doorExtra: self.doorExtra })
            }
          }

          self.cache.set('status', status)
          callback(err, status)
        })
      })
    }

  , _fetchStatus:
    function (callback) {
      const self = this

      const flush = (err, result) => {
        const callbacks = self.callbacks

        self.callbacks = []
        self.client = null
        for (let cb of callbacks) {
          try {
            cb(null, result)
          } catch (ex) {
            self.log.error('callback error: ' + ex.stack)
          }
        }
      }

      if (!self.client) {
        self.client = new APCaccess()
        self.client.connect(self.location.hostname, self.location.port).then(() => {
        debug('fetchStatus', { location: self.location.host, status: 'connected' })
          return self.client.getStatusJson()
        }).then((result) => {
          const client = self.client

          flush(null, result)
          return client.disconnect()
        }).then(() => {
          debug('fetchStatus', { location: self.location.host, status: 'disconnected' })
        }).catch((err) => {
          self.log.error('getStatusJSON error: ' + err.toString())
          flush(err)
        })
      }

      self.callbacks.push(callback)
    }

  , loadExtra:
    function () {
      debug('loadExtra', { location: this.location.host, loaded: this.doorHistory.isHistoryLoaded() })
      let extra

      if (!this.doorHistory.isHistoryLoaded()) return setTimeout(this.loadExtra.bind(this), 100)

      extra = this.doorHistory.getExtraPersistedData()
      if (extra) this.doorExtra = extra
      else this.doorHistory.setExtraPersistedData(this.doorExtra)
      debug('loadExtra', { location: this.location.host, doorExtra: this.doorExtra })
    }

  , getName:
    function (callback) {
      const self = this

      self.fetchStatus(function (err, status) {
        callback(err, (status && status.UPSNAME) || self.name)
      })
    }

  , getModel:
    function (callback) {
      const self = this

      self.fetchStatus(function (err, status) {
        callback(err, (status && status.MODEL) || self.config.model)
      })
    }

  , getSerialNumber:
    function (callback) {
      const self = this

      self.fetchStatus(function (err, status) {
        callback(err, (status && status.SERIALNO) || self.config.serialNo)
      })
    }

  , getFirmwareRevision:
    function (callback) {
      const self = this

      self.fetchStatus(function (err, status) {
        callback(err, ((status && status.FIRMWARE) || self.config.firmware))
      })
    }

  , getInputVoltageAC:
    function (callback) {
      this.fetchStatus(function (err, status) {
        callback(err, status && status.LINEV)
      })
    }

  , getBatteryVoltageDC:
    function (callback) {
      this.fetchStatus(function (err, status) {
        callback(err, status && status.BATTV)
      })
    }

  , getUPSLoadPercent:
    function (callback) {
      this.fetchStatus(function (err, status) {
        callback(err, status && status.LOADPCT)
      })
    }

  , getWatts:
    function (callback) {
      this.fetchStatus(function (err, status) {
        const power = status && status.NOMPOWER
        const percentage = status && status.LOADPCT

        if ((err) || (power === undefined) || (percentage === undefined)) return callback(err)

        callback(err, (power * percentage) / 100.0)
      })
    }

  , getOutputVoltageAC:
    function (callback) {
      this.fetchStatus(function (err, status) {
        callback(err, status && status.OUTPUTV)
      })
    }

  , getCurrentTemperature:
    function (callback) {
      this.fetchStatus(function (err, status) {
        callback(err, status && status.ITEMP)
      })
    }

  , getContactSensorState:
    function (callback) {
      this.fetchStatus(function (err, status) {
        let flags = status && status.STATFLAG

        if ((err) || (flags === undefined)) flags = 0x00
        callback(err, Characteristic.ContactSensorState[(flags & 0x08) ? 'CONTACT_DETECTED' : 'CONTACT_NOT_DETECTED'])
      })
    }

  , getStatusActive:
    function (callback) {
      this.fetchStatus(function (err, status) {
        let percentage = status && status.LOADPCT

        if ((err) || (percentage === undefined)) percentage = 0
        callback(err, Characteristic.Active[percentage ? 'ACTIVE' : 'INACTIVE'])
      })
    }

  , getStatusFault:
    function (callback) {
      callback(null, this.statusFault)
    }

  , getEveTimesOpened:
    function (callback) {
      callback(null, this.doorExtra.timesOpened)
    }

  , getEveOpenDuration:
    function (callback) {
      callback(null, this.doorExtra.openDuration)
    }

  , getEveClosedDuration:
    function (callback) {
      callback(null, this.doorExtra.closedDuration)
    }

  , getEveLastActivation:
    function (callback) {
      callback(null, this.doorExtra.lastActivation)
    }

  , getEveResetTotal:
    function (callback) {
      this.doorHistory.getCharacteristic(CommunityTypes.EveResetTotal).updateValue(this.doorExtra.lastReset)
      callback(null, this.doorExtra.lastReset)
    }

  , setEveResetTotal:
    function (value, callback) {
      this.doorExtra.timesOpened = 0
      this.doorExtra.lastReset = value
      this.doorHistory.setExtraPersistedData(this.doorExtra)
      this.doorHistory.getCharacteristic(CommunityTypes.EveResetTotal).updateValue(this.doorExtra.lastReset)
      callback(null)
    }

  , getBatteryLevel:
    function (callback) {
      this.fetchStatus(function (err, status) {
        let percentage = status && status.BCHARGE

        if ((err) || (percentage === undefined)) percentage = 100
        callback(err, percentage)
      })
    }

  , getChargingState:
    function (callback) {
      this.fetchStatus(function (err, status) {
        const percentage = status && status.BCHARGE
        let flags = status && status.STATFLAG

        if ((err) || (flags === undefined) || (percentage === undefined)) flags = 0x80
        callback(err, Characteristic.ChargingState[(flags & 0x80)                          ? 'NOT_CHARGEABLE'
                                                : ((flags & 0x10) || (percentage === 100)) ? 'NOT_CHARGING'
                                                :                                            'CHARGING'])
      })
    }

  , getStatusLowBattery:
    function (callback) {
      this.fetchStatus(function (err, status) {
        let flags = status && status.STATFLAG

        if ((err) || (flags === undefined)) flags = 0x00
        callback(err, Characteristic.StatusLowBattery[(flags & 0x40) ? 'BATTERY_LEVEL_LOW' : 'BATTERY_LEVEL_NORMAL'])
      })
    }

  , getServices: function () {
      const FakeGatoHistoryService = require('fakegato-history')(homebridge)
          , myAccessoryInformation = new Service.AccessoryInformation()
          , myPowerService = new APC.PowerService(this.name)
          , myContactService = new Service.ContactSensor()
          , myBatteryService = new Service.BatteryService()

      myAccessoryInformation
        .setCharacteristic(Characteristic.Name, this.name)
        .setCharacteristic(Characteristic.Manufacturer, "American Power Conversion (APC)")
      myAccessoryInformation
        .getCharacteristic(Characteristic.Name)
        .on('get', this.getName.bind(this))
      if (this.config.model) myAccessoryInformation.setCharacteristic(Characteristic.Model, this.config.model)
      myAccessoryInformation
        .getCharacteristic(Characteristic.Model)
        .on('get', this.getModel.bind(this))
      if (this.config.serialNo) {
        myAccessoryInformation.setCharacteristic(Characteristic.SerialNumber, this.config.serialNo)
      }
      myAccessoryInformation
        .getCharacteristic(Characteristic.SerialNumber)
        .on('get', this.getSerialNumber.bind(this))
      if (this.config.firmware) {
        myAccessoryInformation.setCharacteristic(Characteristic.FirmwareRevision, this.config.firmware)
      }
      myAccessoryInformation
       .getCharacteristic(Characteristic.FirmwareRevision)
       .on('get', this.getFirmwareRevision.bind(this))

      this.myPowerService = myPowerService
      myPowerService
        .getCharacteristic(CommunityTypes.InputVoltageAC)
        .on('get', this.getInputVoltageAC.bind(this))
      myPowerService
        .getCharacteristic(CommunityTypes.BatteryVoltageDC)
        .on('get', this.getBatteryVoltageDC.bind(this))
      myPowerService
        .getCharacteristic(CommunityTypes.UPSLoadPercent)
        .on('get', this.getUPSLoadPercent.bind(this))

      myContactService
        .getCharacteristic(Characteristic.ContactSensorState)
        .on('get', this.getContactSensorState.bind(this))
      myContactService
        .getCharacteristic(Characteristic.StatusActive)
        .on('get', this.getStatusActive.bind(this))
      myContactService
        .getCharacteristic(Characteristic.StatusFault)
        .on('get', this.getStatusFault.bind(this))
      myContactService.addOptionalCharacteristic(CommunityTypes.EveTimesOpened)
      myContactService
        .getCharacteristic(CommunityTypes.EveTimesOpened)
        .on('get', this.getEveTimesOpened.bind(this))
      myContactService.addOptionalCharacteristic(CommunityTypes.EveOpenDuration)
      myContactService
        .getCharacteristic(CommunityTypes.EveOpenDuration)
        .on('get', this.getEveOpenDuration.bind(this))
      myContactService.addOptionalCharacteristic(CommunityTypes.EveClosedDuration)
      myContactService
        .getCharacteristic(CommunityTypes
        .EveClosedDuration).on('get', this.getEveClosedDuration.bind(this))
      myContactService.addOptionalCharacteristic(CommunityTypes.EveLastActivation)
      myContactService
        .getCharacteristic(CommunityTypes.EveLastActivation)
        .on('get', this.getEveLastActivation.bind(this))
      myContactService.addOptionalCharacteristic(CommunityTypes.EveResetTotal)
      myContactService
        .getCharacteristic(CommunityTypes.EveResetTotal)
        .on('get', this.getEveResetTotal.bind(this))
        .on('set', this.setEveResetTotal.bind(this))

      myBatteryService
        .getCharacteristic(Characteristic.BatteryLevel)
        .on('get', this.getBatteryLevel.bind(this))
      myBatteryService
        .getCharacteristic(Characteristic.ChargingState)
        .on('get', this.getChargingState.bind(this))
      myBatteryService
        .getCharacteristic(Characteristic.StatusLowBattery)
        .on('get', this.getStatusLowBattery.bind(this))

/*
      this.displayName = this.name + ' Energy'
      this.energyHistory = new FakeGatoHistoryService('energy', this, {
        storage      : 'fs',
        disableTimer : true,
        length       : Math.pow(2, 14),
        path         : homebridge.user.cachedAccessoryPath(),
        filename     : this.location.host + '-apcupsd-energy_persist.json'
      })
      this.energyHistory.subtype = 'energy'
 */

      this.displayName = this.name + ' Door'
      this.doorHistory = new FakeGatoHistoryService('door', this, {
        storage      : 'fs',
        disableTimer : true,
        length       : Math.pow(2, 14),
        path         : homebridge.user.cachedAccessoryPath(),
        filename     : this.location.host + '-apcupsd-door_persist.json'
      })
      this.loadExtra()

      setTimeout(this.fetchStatus.bind(this), 1 * 1000)
      setInterval(this.fetchStatus.bind(this), this.options.ttl * 1000)

      return [ myAccessoryInformation
             , myPowerService
             , myContactService
             , myBatteryService
//           , this.energyHistory
             , this.doorHistory
             ]
    }
  }
}

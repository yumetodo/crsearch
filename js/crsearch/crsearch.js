import {default as Mousetrap} from 'mousetrap'
import * as Nagato from 'nagato'

import {Query} from './query'
import {IndexType as IType} from './index-type'
import {Database} from './database'
import {Index} from './index'

import URL from 'url-parse'


class CRSearch {
  static APPNAME = 'crsearch'
  static HOMEPAGE = 'https://github.com/cpprefjp/crsearch'

  static OPTS_DEFAULT = {
    klass: {
      search_button: ['fa', 'fa-fw', 'fa-binoculars'],
    },
    google_url: new URL('https://www.google.co.jp/search'),
    force_new_window: false,
  }

  static KLASS = 'crsearch'
  static RESULT_WRAPPER_KLASS = 'result-wrapper'
  static RESULTS_KLASS = 'results'
  static INPUT_PLACEHOLDER = '"std::...", "<header>", etc.'

  static MAX_RESULT = 5

  static RESULT_PROTO = $('<li class="result"><a href="#"></a></li>')

  static HELP = `
    <div class="help-content">
      <div class="message"></div>
      <ul class="examples">
        <li>
          <h3>Class / Function / Type</h3>
          <div class="query">std::<span class="input"></span></div>
        </li>
        <li>
          <h3>Header file</h3>
          <div class="query">&lt;<span class="input"></span>&gt;</div>
        </li>
        <li>
          <h3>Other / All</h3>
          <div class="query"><span class="input"></span></div>
        </li>
      </ul>
    </div>
  `

  constructor(opts = {}) {
    this.opts = Object.assign({}, CRSearch.OPTS_DEFAULT, opts)
    this.log = new Nagato.Logger(CRSearch.APPNAME, new Nagato.Logger.Option(Object.assign({}, this.opts, {
      icon: {
        text: '\u{1F50E}',
        color: '#3A6E83',
      }
    })))

    this.loaded = false
    this.db = new Map
    this.pendingDB = new Set
    this.last_id = 0
    this.last_input = {}
    this.search_timer = {}
    this.selectIndex = 0
    this.resultCount = 0
    this.hasFocus = false

    Mousetrap.bind('/', function() {
      if (this.hasFocus) return
      return this.select_default_input()
    }.bind(this))

    Mousetrap.bind('esc', function() {
      return this.hide_all_result()
    }.bind(this))

    this.log.info('initialized.')
  }

  async load() {
    try {
      let i = 1
      for (const url of this.pendingDB) {
        if (url.pathname == '/') {
          url.pathname = '/crsearch.json'
        }
        this.log.info(`fetching database (${i}/${this.pendingDB.size}): ${url}`)

        $.ajax({
          url: url,

          success: async (data) => {
            this.log.info('fetched')
            this.parse(url, data)
          },

          fail: async (e) => {
            this.log.error('fetch failed', e)
          }
        })

        ++i
      }
    } finally {
      this.pendingDB.clear()
    }

    this.loaded = true
  }

  async parse(url, json) {
    this.log.info('parsing...', json)

    const db = new Database(this.log, json)
    this.db.set(db.name, db)
    if (!this.defaultUrl) {
      this.defaultUrl = new URL(db.base_url).hostname
    }

    this.updateSearchButton('')
    this.log.info(`parsed '${db.name}'`, db)
    if (this.opts.onDatabase) {
      this.opts.onDatabase(db)
    }
  }

  database(base_url) {
    const autoSuffix = (url) => {
      if (url.pathname === '/') url.pathname = '/crsearch.json'
      return url
    }

    try {
      const url = new URL(base_url)
      this.pendingDB.add(autoSuffix(url).toString())

    } catch (e) {
      const a = document.createElement('a')
      a.href = base_url

      const url = new URL(autoSuffix(a).toString())
      this.pendingDB.add(url)
    }
  }

  selectChange(isUp, box) {
    // this.log.debug('selectChange', 'isUp?: ', isUp, 'selectIndex: ', this.selectIndex, box)

    this.selectIndex += isUp ? -1 : 1
    if (this.selectIndex < 0) {
      this.selectIndex = this.resultCount
    } else if (this.selectIndex > this.resultCount) {
      this.selectIndex = 0
    }

    for (const e of box.find('.results .result')) {
      let link = $(e).children('a')
      if (parseInt($(e).attr('data-result-id')) === this.selectIndex) {
        link.addClass('focus')
        link.focus()
      } else {
        link.removeClass('focus')
        link.blur()
      }
    }

    // this.log.debug(this.selectIndex)
  }

  async do_search(e) {
    clearTimeout(this.search_timer[e.data.id])
    this.search_timer[e.data.id] = setTimeout(async function (e) {
      this.selectIndex = 0
      this.resultCount = await this.do_search_impl(e)
    }.bind(this, e), 20)
  }

  async do_search_impl(e) {
    const q = new Query(this.log, this.last_input[e.data.id])
    // this.log.debug(`query: '${q.original_text}'`, q)

    let result_list = this.clear_results_for(e.target)
    let extra_info_for = {}

    // do the lookup per database
    let res = new Map

    for (const [name, db] of this.db) {
      const ret = db.query(q, 0, CRSearch.MAX_RESULT)
      extra_info_for[db.name] = {url: db.base_url}

      res.set(db.name, ret.targets)
      if (res.get(db.name).length == 0) {
        let msg = $(`<div class="message"><span class="pre">No matches for</span></div>`)
        let rec_q = $('<span class="query" />')
        rec_q.text(q.original_text)
        rec_q.appendTo(msg)

        extra_info_for[db.name].html = msg
        continue
      }

      const found_count = ret.found_count
      if (found_count > CRSearch.MAX_RESULT) {
        extra_info_for[db.name].html = $(`<div class="message">Showing first<span class="match-count">${CRSearch.MAX_RESULT}</span>matches</div>`)
      } else {
        extra_info_for[db.name].html = $(`<div class="message">Showing<span class="match-count">all</span>matches</div>`)
      }
    }

    let result_id = 0
    for (const [db_name, targets] of res) {
      result_list.append(this.make_site_header(db_name, extra_info_for[db_name]))

      const grouped_targets = targets.reduce((gr, e) => {
        const key = e.index.in_header
        gr.set(key, gr.get(key) || [])
        gr.get(key).push(e)
        return gr
      }, new Map)

      // this.log.debug('gr', grouped_targets)

      for (const [in_header, the_targets] of grouped_targets) {
        result_list.append(await this.make_result_header(in_header))

        for (const t of the_targets) {
          let e = await this.make_result(
            t.index.type(),
            t.index,
            t.path
          )

          e.attr('data-result-id', result_id++)
          result_list.append(e)
        }
      }
    }

    for (const [name, db] of this.db) {
      // always include fallback
      let e = await this.make_result(null, q.original_text, {
        name: db.name,
        url: db.base_url.host,
      })
      e.attr('data-result-id', result_id++)
      result_list.append(e)
    }

    // always focus 1st result by default
    // just add 'focused' class, don't actually focus
    result_list.find('.result[data-result-id="0"] > a').addClass('focus')
    return result_id - 1 // i.e. result count
  }

  make_site_header(db_name, extra_info) {
    let elem = $('<li class="result cr-meta-result cr-result-header" />')

    if (extra_info.html) {
      let extra = $(`<div class="extra" />`)

      if (extra_info.klass) {
        extra.addClass(extra_info.klass)
      }
      extra_info.html.appendTo(extra)
      extra.appendTo(elem)
    }

    let dbn = $(`<a class="db-name" />`)
    dbn.attr('href', extra_info.url)
    dbn.attr('target', '_blank')
    dbn.text(db_name)
    dbn.appendTo(elem)
    return elem
  }

  make_google_url(q, site) {
    let url = this.opts.google_url
    url.set('query', {q: `${q} site:${site}`})
    return url
  }

  async make_result_header(header) {
    let elem = $('<li class="result cr-meta-result in-header" />')

    let body = $('<a>')
    if (header) {
      if (this.opts.force_new_window) {
        body.attr('target', '_blank')
      }
      body.attr('href', header.url())
    }
    body.text(header ? header.join() : '(no header)')
    body.appendTo(elem)
    return elem
  }

  async make_result(t, target, extra = null) {
    let elem = CRSearch.RESULT_PROTO.clone()

    let a = elem.children('a')
    let content = $('<div class="content" />').appendTo(a)
    let url = null

    switch (t) {
    case null: {
      elem.addClass('fallback')
      a.attr('href', this.make_google_url(target, extra.url))
      a.attr('target', '_blank')
      $(`<div class="query">${target}</div>`).appendTo(content)
      $(`<div class="fallback-site">${extra.url}</div>`).appendTo(content)
      break
    }

    default:
      a.attr('href', extra)
      content.append(await target.join_html({badges: {switches: ['simple']}}))

      if (this.opts.force_new_window) {
        a.attr('target', '_blank')
      }
      break
    }

    return elem
  }

  async updateSearchButton(href) {
    this.searchButton.attr('href', this.make_google_url(href, this.defaultUrl))
  }

  async searchbox(sel) {
    let box = $(sel).addClass('loading').append($('<div>', {class: 'loading-icon'}))
    if (!this.loaded) {
      await this.load()
    }
    box.removeClass('loading').addClass('loaded')

    this.searchButton = $('<a />')
    this.searchButton.attr('target', '_blank')
    this.searchButton.addClass('search')

    for (const klass of this.opts.klass.search_button) {
      this.searchButton.addClass(klass)
    }

    const id = this.last_id++;
    box.attr('data-crsearch-id', id)
    this.log.info(`creating searchbox ${id}`)


    this.last_input[id] = ''

    let control = $('<div class="control" />')
    control.appendTo(box)

    let input = $('<input type="text" />')
    input.addClass('input')
    input.addClass('mousetrap')
    input.attr('autocomplete', false)
    input.attr('placeholder', CRSearch.INPUT_PLACEHOLDER)
    input.appendTo(control)

    const get_root = () => $(document.activeElement).closest('*[data-crsearch-id="' + id + '"]')
    const is_self = () => !!get_root().length

    const forceFocus = () => {
      const results = get_root().find('.results')
      if (!results.children('.result a:focus').length) {
        results.find('.result a.focus').focus()[0].click()
      }
    }

    Mousetrap.bind('enter', e => {
      if (is_self()) {
        // don't!
        // e.preventDefault()

        forceFocus()
      }
      return true
    })

    Mousetrap.bind('up', e => {
      if (is_self()) {
        e.preventDefault()
        this.selectChange(true, box)
      }
    })
    Mousetrap.bind('down', e => {
      if (is_self()) {
        e.preventDefault()
        this.selectChange(false, box)
      }
    })

    input.on('click', function(e) {
      this.show_result_wrapper_for(e.target)
      return this.select_default_input()
    }.bind(this))

    input.on('keyup', {id: id}, function(e) {
      this.show_result_wrapper_for(e.target)

      const text = $(e.target).val().replace(/\s+/g, ' ').trim()

      if (this.last_input[e.data.id] != text) {
        this.last_input[e.data.id] = text
        this.updateSearchButton(text)

        if (text.length >= 2) {
          this.find_result_wrapper_for(e.target).removeClass('help')
          this.msg_for(e.target)
          this.do_search(e)

        } else if (text.length == 0) {
          this.clear_results_for(e.target)
          this.msg_for(e.target)
          this.find_result_wrapper_for(e.target).addClass('help')

        } else {
          this.clear_results_for(e.target)
          this.msg_for(e.target, text.length == 0 ? '' : 'input >= 2 characters...')
          this.find_result_wrapper_for(e.target).addClass('help')
        }
      }
      return false

    }.bind(this))
    this.default_input = input

    Mousetrap(input.get(0)).bind('esc', function(e) {
      $(e.target).blur()
      return this.hide_all_result()
    }.bind(this))

    let result_wrapper = $('<div />')
    result_wrapper.addClass(CRSearch.RESULT_WRAPPER_KLASS)
    result_wrapper.addClass('help')
    result_wrapper.appendTo(box)

    let results = $('<ul />')
    results.addClass(CRSearch.RESULTS_KLASS)
    results.appendTo(result_wrapper)

    let help_content = $(CRSearch.HELP)
    help_content.appendTo(result_wrapper)

    let cr_info = $('<div class="crsearch-info" />')
    let cr_info_link = $('<a />')
    cr_info_link.attr('href', CRSearch.HOMEPAGE)
    cr_info_link.attr('target', '_blank')
    cr_info_link.text(`${CRSearch.APPNAME} v${CRS_PACKAGE.version}`)
    cr_info_link.appendTo(cr_info)
    cr_info.appendTo(result_wrapper)

    input.on('focusin', function() {
      this.hasFocus = true
      return this.show_result_wrapper_for(this)
    }.bind(this))

    input.on('focusout', () => {
      this.hasFocus = false
    })

    this.searchButton.appendTo(control)
  }

  select_default_input() {
    this.default_input.select()
    return false
  }

  find_cr_for(input) {
    return $(input).closest(`.${CRSearch.KLASS}`)
  }

  find_result_wrapper_for(input) {
    return this.find_cr_for(input).children(`.${CRSearch.RESULT_WRAPPER_KLASS}`)
  }

  find_results_for(input) {
    return this.find_result_wrapper_for(input).children(`.${CRSearch.RESULTS_KLASS}`)
  }

  show_result_wrapper_for(input) {
    this.find_result_wrapper_for(input).addClass('visible')
    return false
  }

  msg_for(input, msg = '') {
    this.find_cr_for(input).find('.result-wrapper .help-content .message').text(msg)
    return false
  }

  hide_result_wrapper_for(input) {
    this.find_result_wrapper_for(input).removeClass('visible')
    return false
  }

  clear_results_for(input) {
    let res = this.find_results_for(input)
    res.empty()
    return res
  }

  hide_all_result() {
    let res = $(`.${CRSearch.KLASS} .${CRSearch.RESULT_WRAPPER_KLASS}`)
    res.removeClass('visible')
    return false
  }
} // CRSearch

export {CRSearch}


/* eslint-disable max-len */
import React from 'react';
import PropTypes from 'prop-types';
import { withTranslation } from 'react-i18next';

import { createSubscribedElement } from '../../UnstatedUtils';
import { toastSuccess, toastError } from '../../../util/apiNotification';

import AppContainer from '../../../services/AppContainer';
import LineBreakSettings from './LineBreakSettings';

class MarkdownSetting extends React.Component {

  constructor(props) {
    super(props);

    const { appContainer } = this.props;

    this.state = {
      isEnabledLinebreaks: appContainer.config.isEnabledLinebreaks,
      isEnabledLinebreaksInComments: appContainer.config.isEnabledLinebreaksInComments,
      //isEnabledLinebreaks: false,
      //isEnabledLinebreaksInComments: false,
      // TODO GW-220 get correct BreakOption value
      pageBreakOption: 1,
      // TODO GW-258 get correct custom regular expression
      customRegularExpression: '',
      // TODO GW-221 get correct Xss value
      isEnabledXss: false,
    };

    this.handleInputChange = this.handleInputChange.bind(this);
    this.changeLineBreakSetting = this.changeLineBreakSetting.bind(this);
  }

  // TODO Delete after component split
  handleInputChange(e) {
    const target = e.target;
    const value = target.type === 'checkbox' ? target.checked : target.value;
    const name = target.name;

    this.setState({ [name]: value });
  }

  changeLineBreakSetting () {
    try {
      this.props.appContainer.apiPost('/admin/markdown/lineBreaksSetting', { isEnabledLinebreaks: this.state.isEnabledLinebreaks });
      toastSuccess('Success change line braek setting');
      this.props.appContainer.apiPost('/admin/markdown/lineBreaksSetting', { isEnabledLinebreaksInComments: this.state.isEnabledLinebreaksInComments });
      toastSuccess('Success change line braek setting in comments');
    }
    catch (err) {
      toastError(err);
    }
  }

  render() {
    const { t } = this.props;

    return (
      <React.Fragment>
        <div className="row my-3">
          <div className="form-group">
            <legend>{ t('markdown_setting.line_break_setting') }</legend>
            <p className="well">{ t('markdown_setting.line_break_setting_desc') }</p>
            <fieldset className="row">
              <div className="form-group">
                <label className="col-xs-4 control-label text-right">
                  { t('markdown_setting.Enable Line Break') }
                </label>
                <div className="col-xs-5">
                  <input type="checkbox" name="isEnabledLinebreaks" checked={this.state.isEnabledLinebreaks} onChange={this.handleInputChange} />
                  <p className="help-block">{ t('markdown_setting.Enable Line Break desc') }</p>
                </div>
              </div>
            </fieldset>
            <fieldset className="row">
              <div className="form-group my-3">
                <label className="col-xs-4 control-label text-right">
                  { t('markdown_setting.Enable Line Break for comment') }
                </label>
                <div className="col-xs-5">
                  <input type="checkbox" name="isEnabledLinebreaksInComments" checked={this.state.isEnabledLinebreaksInComments} onChange={this.handleInputChange} />
                  <p className="help-block">{ t('markdown_setting.Enable Line Break for comment desc') }</p>
                </div>
              </div>
            </fieldset>
          </div>
          <div className="form-group my-3">
            <div className="col-xs-offset-4 col-xs-5">
              <button type="submit" className="btn btn-primary" onClick={this.changeLineBreakSetting}>{ t('Update') }</button>
            </div>
          </div>
        </div>

        <div className="row my-3">
          <div className="form-group">
            <legend>{ t('markdown_setting.presentation_setting') }</legend>
            <p className="well">{ t('markdown_setting.presentation_setting_desc') }</p>
          </div>
          <fieldset className="form-group row my-2">

            <label className="col-xs-3 control-label text-right">
              { t('markdown_setting.Page break setting') }
            </label>

            <div className="col-xs-3 radio radio-primary">
              <input type="radio" id="pageBreakOption1" name="pageBreakOption" value="1" checked={this.state.pageBreakOption === 1} onChange={this.handleInputChange} />
              <label htmlFor="pageBreakOption1">
                <p className="font-weight-bold">{ t('markdown_setting.Preset one separator') }</p>
                <p className="mt-3">
                  { t('markdown_setting.Preset one separator desc') }
                  <pre><code>{ t('markdown_setting.Preset one separator value') }</code></pre>
                </p>
              </label>
            </div>

            <div className="col-xs-3 radio radio-primary mt-3">
              <input type="radio" id="pageBreakOption2" name="pageBreakOption" value="2" checked={this.state.pageBreakOption === 2} onChange={this.handleInputChange} />
              <label htmlFor="pageBreakOption2">
                <p className="font-weight-bold">{ t('markdown_setting.Preset two separator') }</p>
                <p className="mt-3">
                  { t('markdown_setting.Preset two separator desc') }
                  <pre><code>{ t('markdown_setting.Preset two separator value') }</code></pre>
                </p>
              </label>
            </div>

            <div className="col-xs-3 radio radio-primary mt-3">
              <input type="radio" id="pageBreakOption3" name="pageBreakOption" value="3" checked={this.state.pageBreakOption === 3} onChange={this.handleInputChange} />
              <label htmlFor="pageBreakOption3">
                <p className="font-weight-bold">{ t('markdown_setting.Custom separator') }</p>
                <p className="mt-3">
                  { t('markdown_setting.Custom separator desc') }
                  <div>
                    <input className="form-control" name="customRegularExpression" value={this.state.customRegularExpression} onChange={this.handleInputChange} />
                  </div>
                </p>
              </label>
            </div>

            <div className="form-group my-3">
              <div className="col-xs-offset-4 col-xs-5">
                <button type="submit" className="btn btn-primary">{ t('Update') }</button>
              </div>
            </div>

          </fieldset>
        </div>

        <div className="row my-3">
          <div className="form-group">
            <legend>{ t('markdown_setting.XSS_setting') }</legend>
            <p className="well">{ t('markdown_setting.XSS_setting_desc') }</p>
          </div>
          <fieldset className="row">
            <div className="form-group">
              <label className="col-xs-4 control-label text-right">
                { t('markdown_setting.Enable XSS prevention') }
              </label>
              <div className="col-xs-5">
                <input type="checkbox" name="isEnabledXss" checked={this.state.isEnabledXss} onChange={this.handleInputChange} />
              </div>
            </div>

            <div className="form-group my-3">
              <div className="col-xs-offset-4 col-xs-5">
                <button type="submit" className="btn btn-primary">{ t('Update') }</button>
              </div>
            </div>

          </fieldset>
        </div>
      </React.Fragment>
    );
  }

}

const MarkdownSettingWrapper = (props) => {
  return createSubscribedElement(MarkdownSetting, props, [AppContainer]);
};

MarkdownSetting.propTypes = {
  t: PropTypes.func.isRequired, // i18next
  appContainer: PropTypes.instanceOf(AppContainer).isRequired,

};

export default withTranslation()(MarkdownSettingWrapper);
